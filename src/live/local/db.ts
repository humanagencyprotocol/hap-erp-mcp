/**
 * The "local" live adapter's own database — Suveren's own real invoicing on
 * this machine. Deliberately separate from the simulation's database (own
 * file, own schema): a live system and a simulated one must never be able to
 * cross-contaminate, and the schemas differ anyway (local customers carry a
 * UID and multi-line address; local invoices carry a request-supplied
 * `number`, a service period, a tax mode, and an archive fingerprint that the
 * simulation has no use for).
 *
 * SQLite only for now (no Postgres adapter) — this is one person's real
 * invoicing, not a multi-tenant deployment.
 */
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Db } from "../../db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address_lines TEXT NOT NULL,
  country TEXT NOT NULL,
  uid TEXT,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- One shared numbering namespace for invoices AND credit notes (see
-- docs/live-local.md): a number is reserved here, atomically, in the same
-- transaction that inserts the document row. The archive path
-- (<data>/erp-local-archive/<year>/<number>.pdf) depends on this — two
-- documents of different kinds could not otherwise share a year directory
-- without risking a filename collision.
CREATE TABLE IF NOT EXISTS local_numbers (
  number TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('invoice', 'credit_note')),
  document_id TEXT NOT NULL,
  issued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES local_customers(id),
  status TEXT CHECK(status IN ('issued','partially_credited','credited')) NOT NULL DEFAULT 'issued',
  currency TEXT NOT NULL,
  net_total REAL NOT NULL,
  vat_total REAL NOT NULL,
  gross_total REAL NOT NULL,
  credited_total REAL NOT NULL DEFAULT 0,
  tax_mode TEXT CHECK(tax_mode IN ('normal','reverse_charge','kleinunternehmer')) NOT NULL,
  payment_term_days INTEGER NOT NULL DEFAULT 14,
  service_period_from TEXT NOT NULL,
  service_period_to TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  due_date TEXT NOT NULL,
  memo TEXT,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  template_fingerprint TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  ticket_id TEXT
);

CREATE TABLE IF NOT EXISTS local_invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES local_invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_price REAL NOT NULL,
  vat_rate REAL NOT NULL,
  line_net REAL NOT NULL,
  line_vat REAL NOT NULL,
  line_gross REAL NOT NULL
);

-- A correction or cancellation of an issued local invoice — its own number
-- (from the same shared namespace), never a rewrite of the invoice.
CREATE TABLE IF NOT EXISTS local_credit_notes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  invoice_id TEXT NOT NULL REFERENCES local_invoices(id),
  invoice_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES local_customers(id),
  currency TEXT NOT NULL,
  net_total REAL NOT NULL,
  vat_total REAL NOT NULL,
  gross_total REAL NOT NULL,
  reason TEXT NOT NULL,
  service_period_from TEXT NOT NULL,
  service_period_to TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  template_fingerprint TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  ticket_id TEXT
);

CREATE TABLE IF NOT EXISTS local_credit_note_lines (
  id TEXT PRIMARY KEY,
  credit_note_id TEXT NOT NULL REFERENCES local_credit_notes(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_price REAL NOT NULL,
  vat_rate REAL NOT NULL,
  line_net REAL NOT NULL,
  line_vat REAL NOT NULL,
  line_gross REAL NOT NULL
);
`;

/** Default path: <HAP_DATA_DIR ?? ~/.hap>/erp-local.sqlite — kept separate from the simulation's erp.db. */
export function resolveLocalDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ERP_LOCAL_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const dataDir = env.HAP_DATA_DIR ?? join(homedir(), ".hap");
  return join(dataDir, "erp-local.sqlite");
}

export async function createLocalDb(dbPath: string): Promise<Db> {
  const dir = dbPath.includes("/") ? dbPath.slice(0, dbPath.lastIndexOf("/")) : "";
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  return {
    async run(sql: string, params: any[] = []): Promise<void> {
      db.prepare(sql).run(...params);
    },
    async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: any[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}
