import type { Db } from "../db.js";

export interface Item {
  id: string;
  sku: string;
  name: string;
  unit: string;
  list_price: number;
  currency: string;
  stock: number;
}

export async function list_items(db: Db, args: Record<string, any>) {
  const { query, limit = 50 } = args;

  const conditions: string[] = [];
  const params: any[] = [];

  if (query) {
    conditions.push("(sku LIKE ? OR name LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  return db.all<Item>(`SELECT * FROM items ${where} ORDER BY sku LIMIT ?`, params);
}

export async function get_item(db: Db, args: Record<string, any>) {
  const { id } = args;
  const row = await db.get<Item>("SELECT * FROM items WHERE id = ?", [id]);
  if (!row) throw new Error(`Unknown item id: ${id}`);
  return row;
}
