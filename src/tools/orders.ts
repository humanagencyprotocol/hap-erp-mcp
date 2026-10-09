import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import type { Item } from "./items.js";
import { requireCustomer } from "./customers.js";
import { requireQuote, loadQuoteLines, requireCurrentRevision } from "./quotes.js";
import { computeNetTotal, valuesMatch, refuse, roundToCents } from "../money.js";

export interface OrderRow {
  id: string;
  number: string;
  quote_id: string;
  customer_id: string;
  status: "confirmed";
  net_total: number;
  currency: string;
  requested_delivery: string | null;
  created_at: string;
  updated_at: string;
  receipt_id: string | null;
}

async function nextOrderNumber(db: Db): Promise<string> {
  const { count } = (await db.get<{ count: number }>("SELECT COUNT(*) as count FROM orders")) ?? { count: 0 };
  return `O-${String(count + 1).padStart(4, "0")}`;
}

async function orderWithLines(db: Db, id: string) {
  const order = await db.get<OrderRow>("SELECT * FROM orders WHERE id = ?", [id]);
  if (!order) throw new Error(`Unknown order id: ${id}`);
  const lines = await loadQuoteLines(db, order.quote_id);
  return { ...order, lines };
}

export async function convert_quote_to_order(db: Db, args: Record<string, any>) {
  // ticket_id: stored on the existing receipt_id column (internal storage
  // name, unchanged by the v0.7 wire rename of the tool argument).
  const { id, value, discount_pct, currency, revision, requested_delivery, ticket_id } = args;

  const quote = await requireQuote(db, id);
  if (quote.status !== "sent") {
    throw new Error(
      `Quote ${quote.number} (${id}) is ${quote.status}; only sent quotes can be converted to an order` +
        (quote.status === "converted" ? " (it already was)" : "")
    );
  }

  requireCurrentRevision(quote, revision);

  if (currency !== quote.currency) {
    refuse("currency", currency, quote.currency, `Quote ${quote.number} is in ${quote.currency}.`);
  }
  if (discount_pct !== quote.discount_pct) {
    refuse("discount_pct", discount_pct, quote.discount_pct, `Quote ${quote.number}'s discount cannot change at conversion time.`);
  }

  const lines = await loadQuoteLines(db, id);
  const netTotal = computeNetTotal(lines, quote.discount_pct);
  if (!valuesMatch(value, netTotal)) {
    refuse("value", value, netTotal, "Recomputed from the quote's lines and stored discount.");
  }

  const customer = await requireCustomer(db, quote.customer_id);
  const projectedBalance = roundToCents(customer.open_balance + netTotal);
  if (projectedBalance > customer.credit_limit) {
    throw new Error(
      `Refused: credit limit exceeded for ${customer.name} (${customer.id}) — open balance ${customer.open_balance} + ` +
        `order value ${netTotal} = ${projectedBalance}, credit limit is ${customer.credit_limit}.`
    );
  }

  const items = new Map<string, Item>();
  for (const line of lines) {
    if (!items.has(line.item_id)) {
      const item = await db.get<Item>("SELECT * FROM items WHERE id = ?", [line.item_id]);
      if (!item) throw new Error(`Unknown item id: ${line.item_id}`);
      items.set(line.item_id, item);
    }
    const item = items.get(line.item_id)!;
    if (item.stock < line.qty) {
      throw new Error(
        `Refused: insufficient stock for ${item.sku} (${item.name}) — requested ${line.qty}, available ${item.stock}.`
      );
    }
  }

  // Reserve: decrement stock for every line. Checked above in full before any
  // write, so a later line's shortfall never leaves an earlier line's stock
  // decremented — the reservation is all-or-nothing.
  for (const line of lines) {
    await db.run("UPDATE items SET stock = stock - ? WHERE id = ?", [line.qty, line.item_id]);
  }

  const orderId = uuidv4();
  const number = await nextOrderNumber(db);

  await db.run(
    `INSERT INTO orders (id, number, quote_id, customer_id, status, net_total, currency, requested_delivery, receipt_id)
     VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
    [orderId, number, id, quote.customer_id, netTotal, currency, requested_delivery ?? null, ticket_id ?? null]
  );

  await db.run(`UPDATE quotes SET status = 'converted', updated_at = datetime('now') WHERE id = ?`, [id]);

  return orderWithLines(db, orderId);
}

export async function list_orders(db: Db, args: Record<string, any>) {
  const { customer_id, limit = 50 } = args;

  const conditions: string[] = [];
  const params: any[] = [];

  if (customer_id) {
    conditions.push("customer_id = ?");
    params.push(customer_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  return db.all<OrderRow>(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ?`, params);
}

export async function get_order(db: Db, args: Record<string, any>) {
  const { id } = args;
  return orderWithLines(db, id);
}
