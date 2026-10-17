/**
 * Invoicing. German/Austrian invoicing law (Andreas, 2026-10-17): an issued
 * invoice is never changed or deleted. A cancellation or correction is a
 * CREDIT NOTE with its own number — see credit_notes below. Payment
 * collection happens elsewhere; this connector has no payment tools.
 *
 * Like quotes/orders, every change tool recomputes the document's totals
 * from its lines and refuses the call if the caller's declared total does
 * not match (money.ts, computeLineTotals) — the declaration is the only
 * thing a governing layer outside this connector can see.
 */
import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import type { Item } from "./items.js";
import type { OrderRow } from "./orders.js";
import { requireCustomer } from "./customers.js";
import { loadQuoteLines } from "./quotes.js";
import {
  computeLineTotals,
  valuesMatch,
  refuse,
  roundToCents,
  DEFAULT_VAT_RATE,
  INVOICE_VALUE_TOLERANCE,
  type InvoiceLineInput,
  type PricedInvoiceLine,
} from "../money.js";

export interface InvoiceRow {
  id: string;
  number: string;
  customer_id: string;
  order_id: string | null;
  status: "issued" | "partially_credited" | "credited";
  currency: string;
  net_total: number;
  vat_total: number;
  gross_total: number;
  credited_total: number;
  payment_term_days: number;
  issued_at: string;
  due_date: string;
  memo: string | null;
  receipt_id: string | null;
}

export interface InvoiceLineRow extends PricedInvoiceLine {
  id: string;
  invoice_id: string;
}

export interface CreditNoteRow {
  id: string;
  number: string;
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  currency: string;
  net_total: number;
  vat_total: number;
  gross_total: number;
  reason: string;
  issued_at: string;
  receipt_id: string | null;
}

export interface CreditNoteLineRow extends PricedInvoiceLine {
  id: string;
  credit_note_id: string;
}

async function nextNumberForYear(db: Db, table: "invoices" | "credit_notes", prefix: "INV" | "CN", year: number): Promise<string> {
  const like = `${prefix}-${year}-%`;
  const { count } = (await db.get<{ count: number }>(`SELECT COUNT(*) as count FROM ${table} WHERE number LIKE ?`, [like])) ?? {
    count: 0,
  };
  return `${prefix}-${year}-${String(count + 1).padStart(4, "0")}`;
}

/** Validates a caller-declared `lines` array (create_invoice/create_credit_note). Refuses on the first bad line. */
function validateExplicitLines(lines: unknown): InvoiceLineInput[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("lines must be a non-empty array of { description, qty, unit_price, vat_rate }");
  }
  return lines.map((line, i) => {
    const { item_id, description, qty, unit_price, vat_rate } = (line ?? {}) as Record<string, any>;
    if (typeof description !== "string" || !description.trim()) {
      throw new Error(`lines[${i}].description is required`);
    }
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
      throw new Error(`lines[${i}].qty must be a positive number`);
    }
    if (typeof unit_price !== "number" || !Number.isFinite(unit_price) || unit_price < 0) {
      throw new Error(`lines[${i}].unit_price must be a number >= 0`);
    }
    if (typeof vat_rate !== "number" || !Number.isFinite(vat_rate) || vat_rate < 0 || vat_rate > 100) {
      throw new Error(`lines[${i}].vat_rate must be a number between 0 and 100`);
    }
    return { item_id: typeof item_id === "string" ? item_id : null, description, qty, unit_price, vat_rate };
  });
}

/**
 * Lines taken from an order: its items, quantities, and net prices as they
 * were quoted (quote_lines.list_price — a snapshot, not today's catalog
 * price). VAT comes from the item's own vat_rate if set, else DEFAULT_VAT_RATE.
 */
async function deriveLinesFromOrder(db: Db, order: OrderRow): Promise<InvoiceLineInput[]> {
  const quoteLines = await loadQuoteLines(db, order.quote_id);
  const out: InvoiceLineInput[] = [];
  for (const line of quoteLines) {
    const item = await db.get<Item>("SELECT * FROM items WHERE id = ?", [line.item_id]);
    out.push({
      item_id: line.item_id,
      description: item?.name ?? line.item_id,
      qty: line.qty,
      unit_price: line.list_price,
      vat_rate: typeof item?.vat_rate === "number" ? item.vat_rate : DEFAULT_VAT_RATE,
    });
  }
  return out;
}

function validatePaymentTermDays(value: unknown): number {
  if (value === undefined || value === null) return 14;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`payment_term_days must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

async function requireInvoiceRow(db: Db, idOrNumber: string): Promise<InvoiceRow> {
  const byId = await db.get<InvoiceRow>("SELECT * FROM invoices WHERE id = ?", [idOrNumber]);
  if (byId) return byId;
  const byNumber = await db.get<InvoiceRow>("SELECT * FROM invoices WHERE number = ?", [idOrNumber]);
  if (byNumber) return byNumber;
  throw new Error(`Unknown invoice id: ${idOrNumber}`);
}

async function loadInvoiceLines(db: Db, invoiceId: string): Promise<InvoiceLineRow[]> {
  return db.all<InvoiceLineRow>("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid", [invoiceId]);
}

async function invoiceWithLines(db: Db, idOrNumber: string) {
  const invoice = await requireInvoiceRow(db, idOrNumber);
  const lines = await loadInvoiceLines(db, invoice.id);
  return { ...invoice, lines };
}

async function creditNoteWithLines(db: Db, id: string) {
  const creditNote = await db.get<CreditNoteRow>("SELECT * FROM credit_notes WHERE id = ?", [id]);
  if (!creditNote) throw new Error(`Unknown credit note id: ${id}`);
  const lines = await db.all<CreditNoteLineRow>("SELECT * FROM credit_note_lines WHERE credit_note_id = ? ORDER BY rowid", [id]);
  return { ...creditNote, lines };
}

export async function create_invoice(db: Db, args: Record<string, any>) {
  const { customer_id, order_id, lines, net_total, currency, memo, ticket_id } = args;
  const paymentTermDays = validatePaymentTermDays(args.payment_term_days);

  const customer = await requireCustomer(db, customer_id);

  let order: OrderRow | undefined;
  if (order_id !== undefined && order_id !== null) {
    const found = await db.get<OrderRow>("SELECT * FROM orders WHERE id = ?", [order_id]);
    if (!found) throw new Error(`Unknown order id: ${order_id}`);
    if (found.customer_id !== customer_id) {
      throw new Error(
        `Refused: order ${found.number} (${found.id}) belongs to customer ${found.customer_id}, not ${customer_id}.`
      );
    }
    order = found;
  }

  const hasExplicitLines = Array.isArray(lines) && lines.length > 0;
  if (!order && !hasExplicitLines) {
    throw new Error("Refused: create_invoice requires either order_id or a non-empty lines array.");
  }

  const sourceLines = hasExplicitLines ? validateExplicitLines(lines) : await deriveLinesFromOrder(db, order!);
  const totals = computeLineTotals(sourceLines);

  if (!valuesMatch(net_total, totals.net_total, INVOICE_VALUE_TOLERANCE)) {
    refuse("net_total", net_total, totals.net_total, "Recomputed as sum(qty × unit_price), in cents, from the invoice lines.");
  }

  if (order) {
    if (currency !== order.currency) {
      refuse("currency", currency, order.currency, `Order ${order.number} is in ${order.currency}.`);
    }
  } else if (currency !== customer.currency) {
    refuse("currency", currency, customer.currency, `Customer ${customer.name} (${customer.id}) is billed in ${customer.currency}.`);
  }

  if (order) {
    const existing = await db.get<InvoiceRow>(
      "SELECT * FROM invoices WHERE order_id = ? AND status != 'credited' ORDER BY issued_at DESC LIMIT 1",
      [order.id]
    );
    if (existing) {
      const state = existing.status === "issued" ? "issued and not credited" : "only partially credited";
      throw new Error(`Refused: order ${order.number} (${order.id}) already has invoice ${existing.number}, which is ${state}.`);
    }
  }

  const id = uuidv4();
  const year = new Date().getFullYear();
  const number = await nextNumberForYear(db, "invoices", "INV", year);
  const issuedAt = new Date();
  const dueDate = new Date(issuedAt.getTime() + paymentTermDays * 24 * 60 * 60 * 1000);

  await db.run(
    `INSERT INTO invoices (id, number, customer_id, order_id, status, currency, net_total, vat_total, gross_total, credited_total, payment_term_days, issued_at, due_date, memo, receipt_id)
     VALUES (?, ?, ?, ?, 'issued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      id, number, customer_id, order?.id ?? null, currency, totals.net_total, totals.vat_total, totals.gross_total,
      paymentTermDays, issuedAt.toISOString(), dueDate.toISOString(), memo ?? null, ticket_id ?? null,
    ]
  );

  for (const line of totals.lines) {
    await db.run(
      `INSERT INTO invoice_lines (id, invoice_id, item_id, description, qty, unit_price, vat_rate, line_net, line_vat, line_gross)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), id, line.item_id ?? null, line.description, line.qty, line.unit_price, line.vat_rate, line.line_net, line.line_vat, line.line_gross]
    );
  }

  return invoiceWithLines(db, id);
}

export async function create_credit_note(db: Db, args: Record<string, any>) {
  const { invoice_id, credit_total, currency, reason, lines, ticket_id } = args;

  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("reason is required");
  }

  const invoice = await requireInvoiceRow(db, invoice_id);

  if (currency !== invoice.currency) {
    refuse("currency", currency, invoice.currency, `Invoice ${invoice.number} is in ${invoice.currency}.`);
  }

  let totals: { lines: PricedInvoiceLine[]; net_total: number; vat_total: number; gross_total: number };
  if (lines !== undefined) {
    const priced = validateExplicitLines(lines);
    totals = computeLineTotals(priced);
  } else {
    // Omitted lines: credit everything not yet credited. There is no per-line
    // breakdown to recompute from, so the VAT on this credit note is derived
    // from the invoice's own effective rate (vat_total / net_total) applied
    // to the remaining net — the same rate the invoice was actually taxed at.
    const remainingNet = roundToCents(invoice.net_total - invoice.credited_total);
    const effectiveVatRate = invoice.net_total > 0 ? invoice.vat_total / invoice.net_total : 0;
    const vat = roundToCents(remainingNet * effectiveVatRate);
    totals = { lines: [], net_total: remainingNet, vat_total: vat, gross_total: roundToCents(remainingNet + vat) };
  }

  if (!valuesMatch(credit_total, totals.net_total, INVOICE_VALUE_TOLERANCE)) {
    refuse("credit_total", credit_total, totals.net_total, "Recomputed as sum(qty × unit_price), in cents, from the credit lines.");
  }

  const projectedCredited = roundToCents(invoice.credited_total + totals.net_total);
  if (projectedCredited - invoice.net_total > INVOICE_VALUE_TOLERANCE) {
    throw new Error(
      `Refused: credit would exceed invoice ${invoice.number}'s net total — already credited ${invoice.credited_total}, ` +
        `this credit ${totals.net_total}, net total ${invoice.net_total}.`
    );
  }

  const id = uuidv4();
  const year = new Date().getFullYear();
  const number = await nextNumberForYear(db, "credit_notes", "CN", year);
  const issuedAt = new Date().toISOString();

  await db.run(
    `INSERT INTO credit_notes (id, number, invoice_id, invoice_number, customer_id, currency, net_total, vat_total, gross_total, reason, issued_at, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, number, invoice.id, invoice.number, invoice.customer_id, currency, totals.net_total, totals.vat_total, totals.gross_total, reason, issuedAt, ticket_id ?? null]
  );

  for (const line of totals.lines) {
    await db.run(
      `INSERT INTO credit_note_lines (id, credit_note_id, item_id, description, qty, unit_price, vat_rate, line_net, line_vat, line_gross)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), id, line.item_id ?? null, line.description, line.qty, line.unit_price, line.vat_rate, line.line_net, line.line_vat, line.line_gross]
    );
  }

  const newStatus = projectedCredited >= invoice.net_total - INVOICE_VALUE_TOLERANCE ? "credited" : "partially_credited";
  await db.run("UPDATE invoices SET credited_total = ?, status = ? WHERE id = ?", [projectedCredited, newStatus, invoice.id]);

  return creditNoteWithLines(db, id);
}

export async function get_invoice(db: Db, args: Record<string, any>) {
  const { id } = args;
  return invoiceWithLines(db, id);
}

export async function list_invoices(db: Db, args: Record<string, any>) {
  const { customer_id, status, limit = 50 } = args;

  const conditions: string[] = [];
  const params: any[] = [];
  if (customer_id) {
    conditions.push("customer_id = ?");
    params.push(customer_id);
  }
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  return db.all<InvoiceRow>(`SELECT * FROM invoices ${where} ORDER BY issued_at DESC LIMIT ?`, params);
}

export async function get_credit_note(db: Db, args: Record<string, any>) {
  const { id } = args;
  return creditNoteWithLines(db, id);
}

export async function list_credit_notes(db: Db, args: Record<string, any>) {
  const { invoice_id, customer_id, limit = 50 } = args;

  const conditions: string[] = [];
  const params: any[] = [];
  if (invoice_id) {
    conditions.push("invoice_id = ?");
    params.push(invoice_id);
  }
  if (customer_id) {
    conditions.push("customer_id = ?");
    params.push(customer_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  return db.all<CreditNoteRow>(`SELECT * FROM credit_notes ${where} ORDER BY issued_at DESC LIMIT ?`, params);
}
