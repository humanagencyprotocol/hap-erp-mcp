/**
 * `load_simulation` — loads a simulation package (customers + products) into an
 * empty simulated ERP. Create only, never edit: refused once any data exists
 * (a prior load, any recorded change, an item, customer, quote or order) so the
 * test always starts from the package that was actually loaded, not a package
 * silently layered on top of whatever was there before.
 *
 * `clear_simulation` — deletes all of it, the record of changes and refusals
 * included, so the same cases can run again under a different setup (or other
 * cases under the same setup): clear, then load.
 */
import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { parseSimulationPackage } from "../company.js";
import { canonicalSha256 } from "../package-hash.js";

export const ALREADY_LOADED_MESSAGE =
  "Refused: test data already loaded — a simulation can only be created, not edited; clear it first (clear_simulation), then load.";

/** Tables that must be empty before a load. */
const MUST_BE_EMPTY = ["simulation_load", "quotes", "orders", "items", "customers"] as const;

async function assertLoadable(db: Db): Promise<void> {
  for (const table of MUST_BE_EMPTY) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
    if ((row?.n ?? 0) > 0) throw new Error(ALREADY_LOADED_MESSAGE);
  }
  // The clear itself is recorded as a change (the trace of its ticket); it must not block the load after it.
  const changes = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM changes WHERE tool <> 'clear_simulation'`);
  if ((changes?.n ?? 0) > 0) throw new Error(ALREADY_LOADED_MESSAGE);
}

/** Every table that holds test data, in an order the foreign keys allow deleting. */
const CLEAR_ORDER = [
  "quote_lines", "quote_revisions", "orders", "quotes", "items", "customers",
  "changes", "refusals", "triggers", "simulation_load",
] as const;

const INSERT_ITEM = `INSERT INTO items (id, sku, name, unit, list_price, currency, stock) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_CUSTOMER = `INSERT INTO customers (id, name, email, country, currency, credit_limit, open_balance, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export async function load_simulation(db: Db, args: Record<string, any>) {
  const pkg = parseSimulationPackage(args.package);
  await assertLoadable(db);

  const sha256 = canonicalSha256(args.package);

  await db.run("BEGIN");
  try {
    for (const p of pkg.products) {
      await db.run(INSERT_ITEM, [p.id, p.sku, p.name, p.unit, p.list_price, pkg.currency, p.stock]);
    }
    for (const c of pkg.customers) {
      await db.run(INSERT_CUSTOMER, [c.id, c.name, c.email, c.country, pkg.currency, c.credit_limit, c.open_balance, c.payment_terms]);
    }
    await db.run(`INSERT INTO simulation_load (id, name, package_sha256) VALUES (?, ?, ?)`, [uuidv4(), pkg.name, sha256]);
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }

  return { name: pkg.name, customers_loaded: pkg.customers.length, products_loaded: pkg.products.length, package_sha256: sha256 };
}

export async function clear_simulation(db: Db, _args: Record<string, any>) {
  const deleted: Record<string, number> = {};
  await db.run("BEGIN");
  try {
    for (const table of CLEAR_ORDER) {
      const row = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
      deleted[table] = Number(row?.n ?? 0);
      await db.run(`DELETE FROM ${table}`);
    }
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }
  return { cleared: true, deleted };
}
