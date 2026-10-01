import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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
  receipt_id TEXT
);

CREATE TABLE IF NOT EXISTS quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL,
  list_price REAL NOT NULL,
  line_total REAL NOT NULL
);

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

-- Scenario requests handed to the agent, with the moment they were handed over.
CREATE TABLE IF NOT EXISTS triggers (
  scenario_id TEXT PRIMARY KEY,
  triggered_at TEXT DEFAULT (datetime('now')),
  request TEXT NOT NULL,
  expected TEXT
);
`;

/** Tables that carry an authorizing receipt_id (Content Provenance §4.1). */
const RECEIPT_ID_TABLES = ["quotes", "orders"];

/** Demo company used when no ERP_COMPANY_FILE is given. Deterministic. */
export const DEMO_COMPANY: Company = {
  name: "Demo Industrial",
  currency: "EUR",
  items: [
    { id: "item-1", sku: "WIDGET-100", name: "Widget 100", unit: "pcs", list_price: 25.0, stock: 500 },
    { id: "item-2", sku: "WIDGET-200", name: "Widget 200 Pro", unit: "pcs", list_price: 45.0, stock: 300 },
    { id: "item-3", sku: "GEAR-A1", name: "Precision Gear A1", unit: "pcs", list_price: 120.0, stock: 80 },
    { id: "item-4", sku: "GEAR-B2", name: "Precision Gear B2", unit: "pcs", list_price: 150.0, stock: 60 },
    { id: "item-5", sku: "PANEL-S", name: "Control Panel S", unit: "pcs", list_price: 89.5, stock: 150 },
    { id: "item-6", sku: "PANEL-L", name: "Control Panel L", unit: "pcs", list_price: 149.5, stock: 90 },
    { id: "item-7", sku: "CABLE-5M", name: "Cable 5m", unit: "pcs", list_price: 12.0, stock: 1000 },
    { id: "item-8", sku: "SERVICE-KIT", name: "Maintenance Kit", unit: "set", list_price: 340.0, stock: 20 },
  ],
  customers: [
    { id: "cust-1", name: "Nordkap Manufacturing GmbH", email: "ap@nordkap.example", country: "DE", credit_limit: 50000, open_balance: 12000, payment_terms: "NET30" },
    { id: "cust-2", name: "Alpine Components AG", email: "finance@alpinecomp.example", country: "AT", credit_limit: 20000, open_balance: 4000, payment_terms: "NET30" },
    { id: "cust-3", name: "Baltic Retail Group", email: "accounts@balticretail.example", country: "LV", credit_limit: 8000, open_balance: 7500, payment_terms: "NET14" },
    { id: "cust-4", name: "Meridian Industrial Ltd", email: "payables@meridianind.example", country: "IE", credit_limit: 100000, open_balance: 0, payment_terms: "NET60" },
    { id: "cust-5", name: "Solstice Equipment Co", email: "finance@solsticeeq.example", country: "NL", credit_limit: 5000, open_balance: 4800, payment_terms: "NET7" },
  ],
};

const INSERT_ITEM = `INSERT INTO items (id, sku, name, unit, list_price, currency, stock) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_CUSTOMER = `INSERT INTO customers (id, name, email, country, currency, credit_limit, open_balance, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function companyRows(company: Company): { items: any[][]; customers: any[][] } {
  return {
    items: company.items.map((i) => [i.id, i.sku, i.name, i.unit, i.list_price, company.currency, i.stock]),
    customers: company.customers.map((c) => [
      c.id, c.name, c.email, c.country, company.currency, c.credit_limit, c.open_balance, c.payment_terms,
    ]),
  };
}

/** The company to seed from: ERP_COMPANY_FILE if set (refused whole if invalid), else the demo. */
export function resolveCompany(env: NodeJS.ProcessEnv = process.env): Company {
  const path = env.ERP_COMPANY_FILE?.trim();
  return path ? loadCompanyFile(path) : DEMO_COMPANY;
}

function seedSqlite(db: import("better-sqlite3").Database, company: Company): void {
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
async function createSqliteDb(dbPath: string, company: Company): Promise<Db> {
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

// Postgres adapter using pg Pool
async function createPostgresDb(connectionString: string, company: Company): Promise<Db> {
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
    const { rows } = await client.query("SELECT COUNT(*)::int as count FROM items");
    if (rows[0].count === 0) {
      const seed = companyRows(company);
      for (const r of seed.items) await client.query(adaptSql(INSERT_ITEM), r);
      for (const r of seed.customers) await client.query(adaptSql(INSERT_CUSTOMER), r);
    }
  } finally {
    client.release();
  }

  return {
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

export async function createDb(company: Company = resolveCompany()): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    console.error("[erp-mcp] using Postgres");
    return createPostgresDb(databaseUrl, company);
  }

  // SQLite path — honor HAP_DATA_DIR so docker (with a mounted /app/data) and
  // local dev (~/.hap) write to the same place the gateway uses. The gateway
  // injects HAP_DATA_DIR into the child env when spawning this MCP server.
  const hapDir = process.env.HAP_DATA_DIR ?? join(homedir(), ".hap");
  if (!existsSync(hapDir)) {
    mkdirSync(hapDir, { recursive: true });
  }

  const dbPath = databaseUrl || join(hapDir, "erp.db");
  maybeBackupSqlite(dbPath);

  console.error(`[erp-mcp] using SQLite at ${dbPath}`);
  return createSqliteDb(dbPath, company);
}
