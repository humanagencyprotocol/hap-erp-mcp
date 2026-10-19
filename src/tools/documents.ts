/**
 * `get_document` for the simulated ERP — the same invoice / credit-note PDF
 * the "local" live adapter archives, rendered with the SAME template loader,
 * view-model and renderer (live/local/template.ts, view-model.ts,
 * pdf-render.ts). Nothing here is a copy: only the mapping from the
 * simulator's rows to the shared view-model input lives in this file.
 *
 * The simulator keeps no archive, so the PDF is rendered on each call from
 * the stored record. That is still stable: the renderer is deterministic for
 * the same template + variables + issue date (see pdf-render.ts), and an
 * issued document's rows are never changed — so the fingerprint a gateway
 * seals at approval matches the bytes it re-reads at execution.
 *
 * Tax mode is always "normal": the simulator has no company VAT mode and no
 * customer VAT ID, so neither reverse charge nor the small-business exemption
 * can arise (what Local's deriveTaxMode would also return for such data).
 */
import type { Db } from "../db.js";
import { resolveCompany } from "../db.js";
import { buildViewModel, type LineForTemplate } from "../live/local/view-model.js";
import { renderInvoiceDocument } from "../live/local/pdf-render.js";
import { resolveTemplate, requireDocumentSupported, type InvoiceTemplate } from "../live/local/template.js";
import { sha256 } from "../live/local/archive.js";
import type { LiveCompany } from "../live/local/company-file.js";
import { representativeVatRate } from "../live/local/tools/invoices.js";
import { requireInvoiceRow, type CreditNoteRow, type InvoiceRow } from "./invoices.js";
import type { Customer } from "./customers.js";

/**
 * Letterhead defaults. The simulator holds only the company's name, so the
 * rest are obvious placeholders ("Muster…" = sample). They must not say
 * "simulation": the agent under test must not be able to tell the simulated
 * ERP from a real one (test/agent-neutral.test.ts).
 */
export const DEFAULT_SIM_COMPANY: Omit<LiveCompany, "name"> = {
  owner: "Max Mustermann",
  address: { street: "Musterstraße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
  uid: "ATU00000000",
  email: "office@example.com",
  web: "www.example.com",
  register: null,
  bank: { name: "Musterbank", iban: "AT00 0000 0000 0000 0000", bic: "MUSTATWW" },
  default_payment_term_days: 14,
  vat_mode: "normal",
  timezone: "Europe/Vienna",
};

const FALLBACK_COMPANY_NAME = "Musterfirma GmbH";

/** Company name: the loaded simulation package, else ERP_COMPANY_FILE, else a placeholder. */
async function simCompany(db: Db, env: NodeJS.ProcessEnv): Promise<LiveCompany> {
  const loaded = await db.get<{ name: string }>("SELECT name FROM simulation_load ORDER BY at DESC LIMIT 1");
  let name = loaded?.name;
  if (!name) {
    try { name = resolveCompany(env)?.name; } catch { name = undefined; }
  }
  return { ...DEFAULT_SIM_COMPANY, name: name || FALLBACK_COMPANY_NAME };
}

interface SimLineRow {
  item_id: string | null;
  description: string;
  qty: number;
  unit_price: number;
  vat_rate: number;
  line_net: number;
  line_vat: number;
  line_gross: number;
  unit: string | null;
}

async function linesFor(db: Db, table: "invoice_lines" | "credit_note_lines", fk: string, id: string): Promise<LineForTemplate[]> {
  const rows = await db.all<SimLineRow>(
    `SELECT l.item_id, l.description, l.qty, l.unit_price, l.vat_rate, l.line_net, l.line_vat, l.line_gross, i.unit
       FROM ${table} l LEFT JOIN items i ON i.id = l.item_id WHERE l.${fk} = ? ORDER BY l.rowid`,
    [id]
  );
  return rows.map(({ unit, ...l }) => ({ ...l, unit: unit ?? "Stk." }));
}

async function customerFor(db: Db, id: string) {
  const c = await db.get<Customer>("SELECT * FROM customers WHERE id = ?", [id]);
  // The simulator stores no postal address or VAT ID — the address block shows the name only.
  // A document always has a customer row (foreign key); the fallback only keeps an orphan renderable.
  return { name: c?.name ?? id, addressLines: [] as string[], uid: null };
}

/** One-day service period on the issue date — the simulator records no service period. */
function onDay(iso: string) {
  const day = iso.slice(0, 10);
  return { from: day, to: day };
}

export interface SimDocument {
  number: string;
  issuedAt: Date;
  vars: Record<string, unknown>;
}

/** View-model for an invoice the simulator holds — the same buildViewModel Local uses. */
async function invoiceDocument(db: Db, company: LiveCompany, invoice: InvoiceRow): Promise<SimDocument> {
  const issuedAt = new Date(invoice.issued_at);
  const lines = await linesFor(db, "invoice_lines", "invoice_id", invoice.id);
  const vars = buildViewModel({
    company,
    customer: await customerFor(db, invoice.customer_id),
    documentKind: "invoice",
    number: invoice.number,
    issuedAt,
    servicePeriod: onDay(invoice.issued_at),
    lines,
    netTotal: invoice.net_total,
    vatTotal: invoice.vat_total,
    grossTotal: invoice.gross_total,
    taxMode: "normal",
    vatRate: representativeVatRate(lines, invoice.net_total, invoice.vat_total),
    invoiceOnly: { paymentTermDays: invoice.payment_term_days, dueDate: new Date(invoice.due_date) },
  });
  return { number: invoice.number, issuedAt, vars };
}

/** View-model for a credit note — it shares the invoice's tax treatment, as in Local. */
async function creditNoteDocument(db: Db, company: LiveCompany, note: CreditNoteRow): Promise<SimDocument> {
  const invoice = await requireInvoiceRow(db, note.invoice_id);
  const issuedAt = new Date(note.issued_at);
  const lines = await linesFor(db, "credit_note_lines", "credit_note_id", note.id);
  const vars = buildViewModel({
    company,
    customer: await customerFor(db, note.customer_id),
    documentKind: "credit_note",
    number: note.number,
    issuedAt,
    servicePeriod: onDay(invoice.issued_at),
    lines,
    netTotal: note.net_total,
    vatTotal: note.vat_total,
    grossTotal: note.gross_total,
    taxMode: "normal",
    vatRate: representativeVatRate(lines, note.net_total, note.vat_total),
    creditNoteOnly: { invoiceNumber: invoice.number, invoiceIssuedAt: new Date(invoice.issued_at) },
  });
  return { number: note.number, issuedAt, vars };
}

/** Resolves `kind` + `id` to the document's view-model. Unknown ids/kinds throw Local's exact messages. */
export async function resolveSimDocument(
  db: Db,
  args: Record<string, any>,
  template: InvoiceTemplate,
  env: NodeJS.ProcessEnv = process.env
): Promise<SimDocument> {
  const { kind, id } = args;
  if (kind === "invoice-pdf") {
    const invoice = await requireInvoiceRow(db, id);
    requireDocumentSupported(template, "invoice");
    return invoiceDocument(db, await simCompany(db, env), invoice);
  }
  if (kind === "credit-note-pdf") {
    const note = await db.get<CreditNoteRow>("SELECT * FROM credit_notes WHERE id = ? OR number = ?", [id, id]);
    if (!note) throw new Error(`Unknown credit note id: ${id}`);
    requireDocumentSupported(template, "credit_note");
    return creditNoteDocument(db, await simCompany(db, env), note);
  }
  throw new Error(`Unknown document kind: ${JSON.stringify(kind)} — expected "invoice-pdf" or "credit-note-pdf".`);
}

export async function get_document(db: Db, args: Record<string, any>, env: NodeJS.ProcessEnv = process.env) {
  const { template } = resolveTemplate(env);
  const doc = await resolveSimDocument(db, args, template, env);
  const buf = await renderInvoiceDocument(template, doc.vars, doc.issuedAt);
  return {
    filename: `${doc.number}.pdf`,
    contentType: "application/pdf",
    contentBase64: buf.toString("base64"),
    sha256: sha256(buf),
  };
}
