import type { Db } from "../db.js";
import { roundToCents } from "../money.js";

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  country: string | null;
  currency: string;
  credit_limit: number;
  open_balance: number;
  payment_terms: string | null;
}

function withAvailableCredit(row: Customer) {
  return { ...row, available_credit: roundToCents(row.credit_limit - row.open_balance) };
}

export async function find_customers(db: Db, args: Record<string, any>) {
  const { query, limit = 50 } = args;

  const conditions: string[] = [];
  const params: any[] = [];

  if (query) {
    conditions.push("(name LIKE ? OR email LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = await db.all<Customer>(`SELECT * FROM customers ${where} ORDER BY name LIMIT ?`, params);
  return rows.map(withAvailableCredit);
}

export async function get_customer(db: Db, args: Record<string, any>) {
  const { id } = args;
  const row = await db.get<Customer>("SELECT * FROM customers WHERE id = ?", [id]);
  if (!row) throw new Error(`Unknown customer id: ${id}`);
  return withAvailableCredit(row);
}

/** Shared lookup used by the quote/order tools — throws the same "unknown id" shape as the read tool. */
export async function requireCustomer(db: Db, id: string): Promise<Customer> {
  const row = await db.get<Customer>("SELECT * FROM customers WHERE id = ?", [id]);
  if (!row) throw new Error(`Unknown customer id: ${id}`);
  return row;
}
