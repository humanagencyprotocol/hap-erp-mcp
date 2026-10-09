/**
 * Quote revisions (db.ts: ADDED_COLUMNS + backfillQuoteRevisions) must migrate
 * a pre-existing database in place, safely and idempotently — simulation
 * databases exist on real machines already, and this runs on every start.
 *
 * This builds a database with the schema as it was BEFORE this feature (no
 * `quotes.revision`, no `quote_revisions` table, no `changes.revision`),
 * seeds it the way a real one would be after real use, then opens it through
 * `createDb` — the same path a connector restart takes — and checks the
 * migration backfilled correctly, is idempotent, and doesn't touch unrelated
 * data.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { get_quote } from "../src/tools/quotes.js";

const tmp = () => join(tmpdir(), `erp-migration-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

let dbPath: string;
let db: Db | undefined;

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined;
});

/** The pre-revision schema: no `quotes.revision`, no `quote_revisions`, no `changes.revision`. */
const OLD_SCHEMA = `
CREATE TABLE items (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'pcs',
  list_price REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, country TEXT, currency TEXT NOT NULL DEFAULT 'EUR',
  credit_limit REAL NOT NULL DEFAULT 0, open_balance REAL NOT NULL DEFAULT 0, payment_terms TEXT
);
CREATE TABLE quotes (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT CHECK(status IN ('draft','sent','converted','cancelled')) NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL, discount_pct REAL NOT NULL DEFAULT 0, net_total REAL NOT NULL DEFAULT 0,
  valid_until TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT, receipt_id TEXT
);
CREATE TABLE quote_lines (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id), qty INTEGER NOT NULL, list_price REAL NOT NULL, line_total REAL NOT NULL
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, quote_id TEXT NOT NULL REFERENCES quotes(id),
  customer_id TEXT NOT NULL REFERENCES customers(id), status TEXT CHECK(status IN ('confirmed')) NOT NULL DEFAULT 'confirmed',
  net_total REAL NOT NULL, currency TEXT NOT NULL, requested_delivery TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), receipt_id TEXT
);
CREATE TABLE changes (
  id TEXT PRIMARY KEY, at TEXT DEFAULT (datetime('now')), tool TEXT NOT NULL, receipt_id TEXT,
  document_id TEXT, document_number TEXT, status TEXT, net_total REAL
);
CREATE TABLE refusals (
  id TEXT PRIMARY KEY, at TEXT DEFAULT (datetime('now')), tool TEXT NOT NULL, receipt_id TEXT, message TEXT NOT NULL
);
CREATE TABLE triggers (
  scenario_id TEXT PRIMARY KEY, triggered_at TEXT DEFAULT (datetime('now')), request TEXT NOT NULL, expected TEXT
);
CREATE TABLE simulation_load (
  id TEXT PRIMARY KEY, at TEXT DEFAULT (datetime('now')), name TEXT NOT NULL, package_sha256 TEXT NOT NULL
);
`;

/** Builds the old-schema file and seeds it like a real pre-migration database. */
async function buildOldDatabase(): Promise<string> {
  const path = tmp();
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(path);
  raw.exec(OLD_SCHEMA);
  raw.prepare(`INSERT INTO customers (id, name, currency, credit_limit, open_balance) VALUES (?, ?, ?, ?, ?)`)
    .run("cust-old-1", "Legacy Customer GmbH", "EUR", 10000, 0);
  raw.prepare(`INSERT INTO items (id, sku, name, list_price, currency, stock) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("item-old-1", "LEGACY-1", "Legacy Widget", 10, "EUR", 100);
  raw.prepare(`INSERT INTO items (id, sku, name, list_price, currency, stock) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("item-old-2", "LEGACY-2", "Legacy Gadget", 15, "EUR", 50);

  // A sent quote with two lines — the shape a real pre-revision database holds.
  raw.prepare(
    `INSERT INTO quotes (id, number, customer_id, status, currency, discount_pct, net_total, receipt_id)
     VALUES (?, ?, ?, 'sent', ?, ?, ?, ?)`
  ).run("quote-old-1", "Q-0001", "cust-old-1", "EUR", 0, 55, "t-legacy");
  raw.prepare(`INSERT INTO quote_lines (id, quote_id, item_id, qty, list_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("line-1", "quote-old-1", "item-old-1", 1, 10, 10);
  raw.prepare(`INSERT INTO quote_lines (id, quote_id, item_id, qty, list_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("line-2", "quote-old-1", "item-old-2", 3, 15, 45);

  // A second, draft quote — to prove the backfill handles more than one row.
  raw.prepare(
    `INSERT INTO quotes (id, number, customer_id, status, currency, discount_pct, net_total)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)`
  ).run("quote-old-2", "Q-0002", "cust-old-1", "EUR", 0, 10);
  raw.prepare(`INSERT INTO quote_lines (id, quote_id, item_id, qty, list_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("line-3", "quote-old-2", "item-old-1", 1, 10, 10);

  raw.close();
  return path;
}

describe("migrating a pre-revision database", () => {
  it("adds quotes.revision (default 1) and backfills a quote_revisions snapshot for every existing quote", async () => {
    dbPath = await buildOldDatabase();
    process.env.DATABASE_URL = dbPath;
    db = await createDb();

    const q1 = await get_quote(db, { id: "quote-old-1" });
    expect(q1.revision).toBe(1);
    expect(q1.status).toBe("sent"); // untouched by the migration
    expect(q1.net_total).toBe(55);
    expect(q1.lines).toHaveLength(2);

    const q2 = await get_quote(db, { id: "quote-old-2" });
    expect(q2.revision).toBe(1);
    expect(q2.status).toBe("draft");

    const snapshots = await db.all<any>("SELECT quote_id, revision, discount_pct, net_total, currency, receipt_id FROM quote_revisions ORDER BY quote_id");
    expect(snapshots).toEqual([
      { quote_id: "quote-old-1", revision: 1, discount_pct: 0, net_total: 55, currency: "EUR", receipt_id: "t-legacy" },
      { quote_id: "quote-old-2", revision: 1, discount_pct: 0, net_total: 10, currency: "EUR", receipt_id: null },
    ]);

    const snap1 = await db.get<{ lines: string }>("SELECT lines FROM quote_revisions WHERE quote_id = 'quote-old-1'");
    const lines = JSON.parse(snap1!.lines);
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: "item-old-1", qty: 1, list_price: 10, line_total: 10 }),
        expect.objectContaining({ item_id: "item-old-2", qty: 3, list_price: 15, line_total: 45 }),
      ])
    );

    // get_quote with revision:1 explicitly must also work post-migration.
    const explicit = await get_quote(db, { id: "quote-old-1", revision: 1 });
    expect(explicit.net_total).toBe(55);
  });

  it("is idempotent — reopening an already-migrated database does not duplicate snapshots or touch data", async () => {
    dbPath = await buildOldDatabase();
    process.env.DATABASE_URL = dbPath;
    db = await createDb();
    await db.close();

    // Reopen the SAME file through createDb a second time — the real
    // scenario (a connector restart) — and confirm nothing doubled up.
    db = await createDb();

    const snapshots = await db.all<any>("SELECT quote_id FROM quote_revisions ORDER BY quote_id");
    expect(snapshots).toEqual([{ quote_id: "quote-old-1" }, { quote_id: "quote-old-2" }]);

    const quotes = await db.all<any>("SELECT id, revision FROM quotes ORDER BY id");
    expect(quotes).toEqual([
      { id: "quote-old-1", revision: 1 },
      { id: "quote-old-2", revision: 1 },
    ]);
  });

  it("a migrated quote can still move to the next revision normally (update_quote)", async () => {
    dbPath = await buildOldDatabase();
    process.env.DATABASE_URL = dbPath;
    db = await createDb();

    const { update_quote } = await import("../src/tools/quotes.js");
    const updated = await update_quote(db, {
      id: "quote-old-2",
      lines: [{ item_id: "item-old-2", qty: 2 }], // 30.00
      discount_pct: 0,
      value: 30,
      currency: "EUR",
    });
    expect(updated.revision).toBe(2);

    const rev1 = await get_quote(db, { id: "quote-old-2", revision: 1 });
    expect(rev1.net_total).toBe(10); // the migrated snapshot, unchanged
  });
});
