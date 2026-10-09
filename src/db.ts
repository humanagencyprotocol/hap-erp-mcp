import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { loadCompanyFile, type Company } from "./company.js";

export interface Db {
  run(sql: string, params?: any[]): Promise<void>;
  get<T>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T>(sql: string, params?: any[]): Promise<T[]>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  list_price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  stock INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  country TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  credit_limit REAL NOT NULL DEFAULT 0,
  open_balance REAL NOT NULL DEFAULT 0,
  payment_terms TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT CHECK(status IN ('draft','sent','converted','cancelled')) NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  net_total REAL NOT NULL DEFAULT 0,
  valid_until TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT,
  receipt_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL,
  list_price REAL NOT NULL,
  line_total REAL NOT NULL
);

-- One snapshot per quote revision — the content create_quote or update_quote
-- produced, frozen the moment the NEXT revision exists. send_quote and
-- convert_quote_to_order name the revision they act on against quotes.revision;
-- this table is what makes an old revision still readable after that (get_quote
-- with a revision argument) and what a migration backfills revision 1 from for
-- a database that predates this table (see RECEIPT_ID_TABLES-style migration below).
CREATE TABLE IF NOT EXISTS quote_revisions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  lines TEXT NOT NULL,
  discount_pct REAL NOT NULL,
  net_total REAL NOT NULL,
  currency TEXT NOT NULL,
  valid_until TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS quote_revisions_quote_id_revision
  ON quote_revisions (quote_id, revision);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT CHECK(status IN ('confirmed')) NOT NULL DEFAULT 'confirmed',
  net_total REAL NOT NULL,
  currency TEXT NOT NULL,
  requested_delivery TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

-- Calls the connector refused AFTER the gateway let them through. When the gateway
-- injected a receipt_id, a ticket exists for an action that never happened; this
-- table is the only place that says so (the ticket alone reads like a done action).
CREATE TABLE IF NOT EXISTS refusals (
  id TEXT PRIMARY KEY,
  at TEXT DEFAULT (datetime('now')),
  tool TEXT NOT NULL,
  receipt_id TEXT,
  message TEXT NOT NULL
);

-- Every change the ERP performed, one row per call — the effect each ticket produced.
-- A document's own receipt_id column holds only its latest ticket (send overwrites
-- create), so this table, not the document, is what lines up ticket ↔ effect 1:1.
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  at TEXT DEFAULT (datetime('now')),
  tool TEXT NOT NULL,
  receipt_id TEXT,
  document_id TEXT,
  document_number TEXT,
  status TEXT,
  net_total REAL,
  revision INTEGER
);

-- Scenario requests handed to the agent, with the moment they were handed over.
CREATE TABLE IF NOT EXISTS triggers (
  scenario_id TEXT PRIMARY KEY,
  triggered_at TEXT DEFAULT (datetime('now')),
  request TEXT NOT NULL,
  expected TEXT
);

-- The simulation package load_simulation loaded into this (then-empty) database,
-- if any. A row here is both the proof a package was loaded and the create-only
-- guard: load_simulation refuses while this table is non-empty.
CREATE TABLE IF NOT EXISTS simulation_load (
  id TEXT PRIMARY KEY,
  at TEXT DEFAULT (datetime('now')),
  name TEXT NOT NULL,
  package_sha256 TEXT NOT NULL
);
`;

/** Tables that carry an authorizing receipt_id (Content Provenance §4.1). */
const RECEIPT_ID_TABLES = ["quotes", "orders"];

/**
 * Columns added to tables that may already exist from before this column was
 * introduced. `sqliteDdl`/`postgresDdl` are the full `ADD COLUMN` type+default
 * clause for each backend — kept separate because SQLite and Postgres accept
 * slightly different syntax for the same default.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; sqliteDdl: string; postgresDdl: string }> = [
  { table: "quotes", column: "revision", sqliteDdl: "INTEGER NOT NULL DEFAULT 1", postgresDdl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "changes", column: "revision", sqliteDdl: "INTEGER", postgresDdl: "INTEGER" },
];

const INSERT_ITEM = `INSERT INTO items (id, sku, name, unit, list_price, currency, stock) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_CUSTOMER = `INSERT INTO customers (id, name, email, country, currency, credit_limit, open_balance, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

interface QuoteRowForBackfill {
  id: string;
  revision: number;
  discount_pct: number;
  net_total: number;
  currency: string;
  valid_until: string | null;
  notes: string | null;
  created_at: string;
  receipt_id: string | null;
}

/**
 * Backfills `quote_revisions` for any quote that does not yet have a snapshot
 * at its current revision — a database created before this table existed has
 * quotes but no rows here at all; one created after it exists has them for
 * every quote going forward. Idempotent: runs on every start, inserts nothing
 * for a quote that already has its snapshot, so re-running it on an
 * already-migrated database (or a demo database on a real machine) is a
 * no-op. Lines are read the same way `loadQuoteLines` reads them elsewhere in
 * this connector, kept inline here rather than imported to avoid a cycle
 * between this module and the tools that depend on its `Db` type.
 */
async function backfillQuoteRevisions(db: Db): Promise<void> {
  const quotes = await db.all<QuoteRowForBackfill>("SELECT * FROM quotes");
  for (const q of quotes) {
    const existing = await db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM quote_revisions WHERE quote_id = ? AND revision = ?",
      [q.id, q.revision]
    );
    if ((existing?.n ?? 0) > 0) continue;

    // Not `ORDER BY rowid` (as `loadQuoteLines` elsewhere in this connector
    // uses on SQLite) — this runs against Postgres too, which has no rowid.
    // Order doesn't matter for a backfilled historical snapshot: it is the
    // same set of lines either way.
    const lines = await db.all<{ item_id: string; qty: number; list_price: number; line_total: number }>(
      "SELECT item_id, qty, list_price, line_total FROM quote_lines WHERE quote_id = ? ORDER BY item_id",
      [q.id]
    );
    await db.run(
      `INSERT INTO quote_revisions (id, quote_id, revision, lines, discount_pct, net_total, currency, valid_until, notes, created_at, receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), q.id, q.revision, JSON.stringify(lines), q.discount_pct, q.net_total, q.currency,
        q.valid_until ?? null, q.notes ?? null, q.created_at, q.receipt_id ?? null,
      ]
    );
  }
}

function companyRows(company: Company): { items: any[][]; customers: any[][] } {
  return {
    items: company.items.map((i) => [i.id, i.sku, i.name, i.unit, i.list_price, company.currency, i.stock]),
    customers: company.customers.map((c) => [
      c.id, c.name, c.email, c.country, company.currency, c.credit_limit, c.open_balance, c.payment_terms,
    ]),
  };
}

/**
 * The company to seed an empty database from: ERP_COMPANY_FILE if set (refused whole
 * if invalid). Without it the ERP starts empty — test data comes from load_simulation.
 */
export function resolveCompany(env: NodeJS.ProcessEnv = process.env): Company | undefined {
  const path = env.ERP_COMPANY_FILE?.trim();
  return path ? loadCompanyFile(path) : undefined;
}

function seedSqlite(db: import("better-sqlite3").Database, company: Company | undefined): void {
  if (!company) return;
  const { count } = db.prepare("SELECT COUNT(*) as count FROM items").get() as { count: number };
  if (count > 0) {
    if (process.env.ERP_COMPANY_FILE) {
      console.error("[erp-mcp] database already holds data — ERP_COMPANY_FILE not loaded (start from an empty database to load it)");
    }
    return;
  }
  const rows = companyRows(company);
  const insertItem = db.prepare(INSERT_ITEM);
  const insertCustomer = db.prepare(INSERT_CUSTOMER);
  db.transaction(() => {
    for (const r of rows.items) insertItem.run(...r);
    for (const r of rows.customers) insertCustomer.run(...r);
  })();
  console.error(`[erp-mcp] seeded "${company.name}": ${company.items.length} items, ${company.customers.length} customers`);
}

// SQLite adapter using better-sqlite3 (synchronous API wrapped in async)
async function createSqliteDb(dbPath: string, company: Company | undefined): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedSqlite(db, company);

  // Migration: add receipt_id to pre-existing tables (Content Provenance §4.1).
  // ALTER ... ADD COLUMN throws if it already exists, so guard on table_info.
  for (const table of RECEIPT_ID_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "receipt_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN receipt_id TEXT`);
    }
  }
  // Migration: quote revisions (see ADDED_COLUMNS) — same guarded-ALTER pattern.
  for (const { table, column, sqliteDdl } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqliteDdl}`);
    }
  }

  const wrapped: Db = {
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
  await backfillQuoteRevisions(wrapped);
  return wrapped;
}

// Postgres adapter using pg Pool
async function createPostgresDb(connectionString: string, company: Company | undefined): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });

  // Adapt SQLite-style ? placeholders to Postgres $1, $2, ... style
  function adaptSql(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  const pgSchema = SCHEMA.replace(/datetime\('now'\)/g, "NOW()");

  const client = await pool.connect();
  try {
    await client.query(pgSchema);
    // Migration: add receipt_id to pre-existing tables (Content Provenance §4.1).
    for (const table of RECEIPT_ID_TABLES) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS receipt_id TEXT`);
    }
    // Migration: quote revisions (see ADDED_COLUMNS) — same guarded-ALTER pattern.
    for (const { table, column, postgresDdl } of ADDED_COLUMNS) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${postgresDdl}`);
    }
    const { rows } = await client.query("SELECT COUNT(*)::int as count FROM items");
    if (company && rows[0].count === 0) {
      const seed = companyRows(company);
      for (const r of seed.items) await client.query(adaptSql(INSERT_ITEM), r);
      for (const r of seed.customers) await client.query(adaptSql(INSERT_CUSTOMER), r);
    }
  } finally {
    client.release();
  }

  const wrapped: Db = {
    async run(sql: string, params: any[] = []): Promise<void> {
      await pool.query(adaptSql(sql), params);
    },
    async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows[0] as T | undefined;
    },
    async all<T>(sql: string, params: any[] = []): Promise<T[]> {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows as T[];
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
  await backfillQuoteRevisions(wrapped);
  return wrapped;
}

function maybeBackupSqlite(dbPath: string): void {
  const backupPath = dbPath.replace(/\.db$/, ".backup.db");
  if (!existsSync(dbPath)) return;

  const shouldBackup =
    !existsSync(backupPath) ||
    Date.now() - statSync(backupPath).mtimeMs > 24 * 60 * 60 * 1000;

  if (shouldBackup) {
    try {
      copyFileSync(dbPath, backupPath);
      console.error(`[erp-mcp] backup written to ${backupPath}`);
    } catch (err) {
      console.error(`[erp-mcp] backup failed: ${err}`);
    }
  }
}

export async function createDb(company: Company | undefined = resolveCompany()): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    console.error("[erp-mcp] using Postgres");
    return createPostgresDb(databaseUrl, company);
  }

  // SQLite path — honor HAP_DATA_DIR so docker (with a mounted /app/data) and
  // local dev (~/.hap) write to the same place the gateway uses. The gateway
  // injects HAP_DATA_DIR into the child env when spawning this MCP server.
  // Only create the data directory when the default path is actually used — an
  // explicit DATABASE_URL must not leave an empty ~/.hap behind.
  let dbPath = databaseUrl;
  if (!dbPath) {
    const hapDir = process.env.HAP_DATA_DIR ?? join(homedir(), ".hap");
    if (!existsSync(hapDir)) mkdirSync(hapDir, { recursive: true });
    dbPath = join(hapDir, "erp.db");
  }
  maybeBackupSqlite(dbPath);

  console.error(`[erp-mcp] using SQLite at ${dbPath}`);
  return createSqliteDb(dbPath, company);
}
