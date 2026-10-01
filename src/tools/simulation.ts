/**
 * `load_simulation` — loads a simulation package (customers + products) into an
 * empty simulated ERP. Create only, never edit: refused once test data exists
 * (a prior load, any recorded change, or a quote/order) so the three-week test
 * always starts from the package that was actually loaded, not a package
 * silently layered on top of whatever was there before.
 *
 * The auto-seeded demo data (DEMO_COMPANY, see db.ts) is the one exception —
 * it has no quotes, orders or changes yet, so the first load replaces it.
 */
import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { parseSimulationPackage } from "../company.js";
import { canonicalSha256 } from "../package-hash.js";

export const ALREADY_LOADED_MESSAGE =
  "Refused: test data already loaded — a simulation can only be created, not edited; start from an empty database.";

/** Tables whose emptiness proves this database has never been used for anything real. */
const MUST_BE_EMPTY = ["simulation_load", "changes", "quotes", "orders"] as const;

async function assertLoadable(db: Db): Promise<void> {
  for (const table of MUST_BE_EMPTY) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
    if ((row?.n ?? 0) > 0) throw new Error(ALREADY_LOADED_MESSAGE);
  }
}

const INSERT_ITEM = `INSERT INTO items (id, sku, name, unit, list_price, currency, stock) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_CUSTOMER = `INSERT INTO customers (id, name, email, country, currency, credit_limit, open_balance, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export async function load_simulation(db: Db, args: Record<string, any>) {
  const pkg = parseSimulationPackage(args.package);
  await assertLoadable(db);

  const sha256 = canonicalSha256(args.package);

  await db.run("BEGIN");
  try {
    // Replace the auto-seeded demo catalog/customers — guarded above to only
    // ever run against a database with no quotes, orders, changes or prior load.
    await db.run(`DELETE FROM items`);
    await db.run(`DELETE FROM customers`);
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
