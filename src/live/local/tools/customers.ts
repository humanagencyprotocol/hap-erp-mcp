/**
 * Local customers. The AI has no tool to create or change one — only the
 * person does, through the CLI (`erp-mcp customers add|list|import`, see
 * cli.ts). find_customers/get_customer are the only MCP-exposed surface.
 */
import { randomUUID } from "crypto";
import type { Db } from "../../../db.js";

export interface LocalCustomer {
  id: string;
  name: string;
  address_lines: string; // JSON-encoded string[] in storage
  country: string;
  uid: string | null;
  email: string | null;
  created_at: string;
}

export interface LocalCustomerView {
  id: string;
  name: string;
  address_lines: string[];
  country: string;
  uid: string | null;
  email: string | null;
}

function toView(row: LocalCustomer): LocalCustomerView {
  return { id: row.id, name: row.name, address_lines: JSON.parse(row.address_lines), country: row.country, uid: row.uid, email: row.email };
}

export async function find_customers(db: Db, args: Record<string, any>): Promise<LocalCustomerView[]> {
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
  const rows = await db.all<LocalCustomer>(`SELECT * FROM local_customers ${where} ORDER BY name LIMIT ?`, params);
  return rows.map(toView);
}

export async function get_customer(db: Db, args: Record<string, any>): Promise<LocalCustomerView> {
  const row = await requireLocalCustomer(db, args.id);
  return toView(row);
}

export async function requireLocalCustomer(db: Db, id: string): Promise<LocalCustomer> {
  const row = await db.get<LocalCustomer>("SELECT * FROM local_customers WHERE id = ?", [id]);
  if (!row) throw new Error(`Unknown customer id: ${id}`);
  return row;
}

// --- CLI-only (not MCP tools) ---

export interface NewLocalCustomer {
  id?: string;
  name: string;
  address_lines: string[];
  country: string;
  uid?: string | null;
  email?: string | null;
}

function validateNewCustomer(raw: unknown, at: string): Required<Omit<NewLocalCustomer, "id">> & { id?: string } {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.name !== "string" || !c.name.trim()) throw new Error(`${at}.name is required`);
  if (!Array.isArray(c.address_lines) || c.address_lines.length === 0 || !c.address_lines.every((l) => typeof l === "string" && l.trim())) {
    throw new Error(`${at}.address_lines must be a non-empty array of non-empty strings`);
  }
  if (typeof c.country !== "string" || !/^[A-Za-z]{2}$/.test(c.country)) throw new Error(`${at}.country must be a 2-letter ISO code, e.g. AT`);
  if (c.uid !== undefined && c.uid !== null && typeof c.uid !== "string") throw new Error(`${at}.uid must be a string or null`);
  if (c.email !== undefined && c.email !== null && typeof c.email !== "string") throw new Error(`${at}.email must be a string or null`);
  return {
    id: typeof c.id === "string" ? c.id : undefined,
    name: c.name as string,
    address_lines: c.address_lines as string[],
    country: (c.country as string).toUpperCase(),
    uid: (c.uid as string | null) ?? null,
    email: (c.email as string | null) ?? null,
  };
}

export async function addCustomer(db: Db, raw: unknown): Promise<LocalCustomerView> {
  const c = validateNewCustomer(raw, "customer");
  const id = c.id ?? randomUUID();
  const existing = await db.get<{ n: number }>("SELECT COUNT(*) as n FROM local_customers WHERE id = ?", [id]);
  if ((existing?.n ?? 0) > 0) throw new Error(`Refused: customer id ${id} already exists.`);
  await db.run(
    `INSERT INTO local_customers (id, name, address_lines, country, uid, email) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, c.name, JSON.stringify(c.address_lines), c.country, c.uid, c.email]
  );
  return toView(await requireLocalCustomer(db, id));
}

/** All-or-nothing: validates every entry, and checks every id against existing rows, before inserting any. */
export async function importCustomers(db: Db, rawList: unknown): Promise<LocalCustomerView[]> {
  if (!Array.isArray(rawList) || rawList.length === 0) throw new Error("customers import: input must be a non-empty JSON array");
  const parsed = rawList.map((raw, i) => validateNewCustomer(raw, `customers[${i}]`));

  const ids = parsed.map((c) => c.id ?? randomUUID());
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`customers import: id ${id} appears twice in the input — nothing was saved.`);
    seen.add(id);
  }
  for (const id of ids) {
    const existing = await db.get<{ n: number }>("SELECT COUNT(*) as n FROM local_customers WHERE id = ?", [id]);
    if ((existing?.n ?? 0) > 0) throw new Error(`Refused: customer id ${id} already exists — nothing in this import was saved.`);
  }

  await db.run("BEGIN");
  try {
    for (let i = 0; i < parsed.length; i++) {
      const c = parsed[i];
      const id = ids[i];
      await db.run(
        `INSERT INTO local_customers (id, name, address_lines, country, uid, email) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, c.name, JSON.stringify(c.address_lines), c.country, c.uid, c.email]
      );
    }
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }

  const out: LocalCustomerView[] = [];
  for (const id of ids) out.push(toView(await requireLocalCustomer(db, id)));
  return out;
}

export async function listCustomersForCli(db: Db): Promise<LocalCustomerView[]> {
  const rows = await db.all<LocalCustomer>("SELECT * FROM local_customers ORDER BY name");
  return rows.map(toView);
}
