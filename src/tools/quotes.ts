import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import type { Item } from "./items.js";
import { requireCustomer } from "./customers.js";
import { computeNetTotal, valuesMatch, refuse, type PricedLine } from "../money.js";

export interface QuoteRow {
  id: string;
  number: string;
  customer_id: string;
  status: "draft" | "sent" | "converted" | "cancelled";
  currency: string;
  discount_pct: number;
  net_total: number;
  valid_until: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  receipt_id: string | null;
}

export interface QuoteLineRow extends PricedLine {
  id: string;
  quote_id: string;
  item_id: string;
  line_total: number;
}

interface LineInput {
  item_id: string;
  qty: number;
}

interface PricedInputLine {
  item_id: string;
  qty: number;
  list_price: number;
  line_total: number;
}

/** Looks up each line's item and snapshots its current list price. Refuses unknown items and invalid quantities. */
async function priceLines(db: Db, lines: LineInput[]): Promise<PricedInputLine[]> {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("lines must be a non-empty array of { item_id, qty }");
  }

  const priced: PricedInputLine[] = [];
  for (const line of lines) {
    const { item_id, qty } = line ?? {};
    if (!item_id) {
      throw new Error("Every line requires an item_id");
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(`Invalid qty for item ${item_id}: ${JSON.stringify(qty)} (must be a positive integer)`);
    }

    const item = await db.get<Item>("SELECT * FROM items WHERE id = ?", [item_id]);
    if (!item) {
      throw new Error(`Unknown item id: ${item_id}`);
    }

    priced.push({
      item_id,
      qty,
      list_price: item.list_price,
      line_total: Math.round(item.list_price * qty * 100) / 100,
    });
  }
  return priced;
}

function validateDiscountPct(discount_pct: unknown): number {
  if (typeof discount_pct !== "number" || !Number.isFinite(discount_pct) || discount_pct < 0 || discount_pct > 100) {
    refuse("discount_pct", discount_pct, "a number between 0 and 100");
  }
  return discount_pct as number;
}

async function nextNumber(db: Db, table: "quotes" | "orders", prefix: "Q" | "O"): Promise<string> {
  const { count } = (await db.get<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`)) ?? { count: 0 };
  return `${prefix}-${String(count + 1).padStart(4, "0")}`;
}

export async function requireQuote(db: Db, id: string): Promise<QuoteRow> {
  const row = await db.get<QuoteRow>("SELECT * FROM quotes WHERE id = ?", [id]);
  if (!row) throw new Error(`Unknown quote id: ${id}`);
  return row;
}

export async function loadQuoteLines(db: Db, quoteId: string): Promise<QuoteLineRow[]> {
  return db.all<QuoteLineRow>("SELECT * FROM quote_lines WHERE quote_id = ? ORDER BY rowid", [quoteId]);
}

async function quoteWithLines(db: Db, id: string) {
  const quote = await requireQuote(db, id);
  const lines = await loadQuoteLines(db, id);
  return { ...quote, lines };
}

export async function create_quote(db: Db, args: Record<string, any>) {
  const { customer_id, lines, discount_pct, value, currency, valid_until, notes, receipt_id } = args;

  const customer = await requireCustomer(db, customer_id);
  const priced = await priceLines(db, lines);
  const discountPct = validateDiscountPct(discount_pct);

  if (currency !== customer.currency) {
    refuse("currency", currency, customer.currency, `Customer ${customer.name} (${customer.id}) is billed in ${customer.currency}.`);
  }

  const netTotal = computeNetTotal(priced, discountPct);
  if (!valuesMatch(value, netTotal)) {
    refuse("value", value, netTotal, "Recomputed from the quote lines and the declared discount.");
  }

  const id = uuidv4();
  const number = await nextNumber(db, "quotes", "Q");

  await db.run(
    `INSERT INTO quotes (id, number, customer_id, status, currency, discount_pct, net_total, valid_until, notes, receipt_id)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    [id, number, customer_id, currency, discountPct, netTotal, valid_until ?? null, notes ?? null, receipt_id ?? null]
  );

  for (const line of priced) {
    await db.run(
      `INSERT INTO quote_lines (id, quote_id, item_id, qty, list_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), id, line.item_id, line.qty, line.list_price, line.line_total]
    );
  }

  return quoteWithLines(db, id);
}

export async function update_quote(db: Db, args: Record<string, any>) {
  const { id, lines, discount_pct, value, currency, valid_until, notes, receipt_id } = args;

  const quote = await requireQuote(db, id);
  if (quote.status !== "draft") {
    throw new Error(`Quote ${quote.number} (${id}) is ${quote.status}; only draft quotes can be updated`);
  }

  const priced = lines !== undefined ? await priceLines(db, lines) : await loadQuoteLines(db, id);
  const discountPct = validateDiscountPct(discount_pct);

  if (currency !== quote.currency) {
    refuse("currency", currency, quote.currency, `Quote ${quote.number} was created in ${quote.currency}; currency cannot change on update.`);
  }

  const netTotal = computeNetTotal(priced, discountPct);
  if (!valuesMatch(value, netTotal)) {
    refuse("value", value, netTotal, "Recomputed from the quote lines and the declared discount.");
  }

  if (lines !== undefined) {
    await db.run("DELETE FROM quote_lines WHERE quote_id = ?", [id]);
    for (const line of priced) {
      await db.run(
        `INSERT INTO quote_lines (id, quote_id, item_id, qty, list_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), id, line.item_id, line.qty, line.list_price, line.line_total]
      );
    }
  }

  await db.run(
    `UPDATE quotes SET discount_pct = ?, net_total = ?, valid_until = ?, notes = ?, receipt_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [discountPct, netTotal, valid_until ?? quote.valid_until ?? null, notes ?? quote.notes ?? null, receipt_id ?? quote.receipt_id ?? null, id]
  );

  return quoteWithLines(db, id);
}

export async function send_quote(db: Db, args: Record<string, any>) {
  const { id, value, discount_pct, currency, receipt_id } = args;

  const quote = await requireQuote(db, id);
  if (quote.status !== "draft") {
    throw new Error(`Quote ${quote.number} (${id}) is ${quote.status}; only draft quotes can be sent`);
  }

  if (currency !== quote.currency) {
    refuse("currency", currency, quote.currency, `Quote ${quote.number} is in ${quote.currency}.`);
  }
  if (discount_pct !== quote.discount_pct) {
    refuse("discount_pct", discount_pct, quote.discount_pct, `Quote ${quote.number}'s discount cannot change at send time — edit the draft first.`);
  }

  const lines = await loadQuoteLines(db, id);
  const netTotal = computeNetTotal(lines, quote.discount_pct);
  if (!valuesMatch(value, netTotal)) {
    refuse("value", value, netTotal, "Recomputed from the quote's lines and stored discount.");
  }

  await db.run(
    `UPDATE quotes SET status = 'sent', sent_at = datetime('now'), receipt_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [receipt_id ?? quote.receipt_id ?? null, id]
  );

  return quoteWithLines(db, id);
}

export async function list_quotes(db: Db, args: Record<string, any>) {
  const { status, customer_id, limit = 50 } = args;

  const conditions: string[] = [];
  const params: any[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (customer_id) {
    conditions.push("customer_id = ?");
    params.push(customer_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  return db.all<QuoteRow>(`SELECT * FROM quotes ${where} ORDER BY created_at DESC LIMIT ?`, params);
}

export async function get_quote(db: Db, args: Record<string, any>) {
  const { id } = args;
  return quoteWithLines(db, id);
}
