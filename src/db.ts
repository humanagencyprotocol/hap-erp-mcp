import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
`;

/** Tables that carry an authorizing receipt_id (Content Provenance §4.1). */
const RECEIPT_ID_TABLES = ["quotes", "orders"];

/** Deterministic demo dataset, seeded once when the items table is empty. */
const SEED_ITEMS: Array<[string, string, string, string, number, number]> = [
  // id, sku, name, unit, list_price, stock
  ["item-1", "WIDGET-100", "Widget 100", "pcs", 25.0, 500],
  ["item-2", "WIDGET-200", "Widget 200 Pro", "pcs", 45.0, 300],
  ["item-3", "GEAR-A1", "Precision Gear A1", "pcs", 120.0, 80],
  ["item-4", "GEAR-B2", "Precision Gear B2", "pcs", 150.0, 60],
  ["item-5", "PANEL-S", "Control Panel S", "pcs", 89.5, 150],
  ["item-6", "PANEL-L", "Control Panel L", "pcs", 149.5, 90],
  ["item-7", "CABLE-5M", "Cable 5m", "pcs", 12.0, 1000],
  ["item-8", "SERVICE-KIT", "Maintenance Kit", "set", 340.0, 20],
];

const SEED_CUSTOMERS: Array<[string, string, string, string, number, number, string]> = [
  // id, name, email, country, credit_limit, open_balance, payment_terms
  ["cust-1", "Nordkap Manufacturing GmbH", "ap@nordkap.example", "DE", 50000, 12000, "NET30"],
  ["cust-2", "Alpine Components AG", "finance@alpinecomp.example", "AT", 20000, 4000, "NET30"],
  ["cust-3", "Baltic Retail Group", "accounts@balticretail.example", "LV", 8000, 7500, "NET14"],
  ["cust-4", "Meridian Industrial Ltd", "payables@meridianind.example", "IE", 100000, 0, "NET60"],
  ["cust-5", "Solstice Equipment Co", "finance@solsticeeq.example", "NL", 5000, 4800, "NET7"],
];

function seedSqlite(db: import("better-sqlite3").Database): void {
  const { count } = db.prepare("SELECT COUNT(*) as count FROM items").get() as { count: number };
  if (count > 0) return;

  const insertItem = db.prepare(
    `INSERT INTO items (id, sku, name, unit, list_price, currency, stock) VALUES (?, ?, ?, ?, ?, 'EUR', ?)`
  );
  for (const [id, sku, name, unit, listPrice, stock] of SEED_ITEMS) {
    insertItem.run(id, sku, name, unit, listPrice, stock);
  }

  const insertCustomer = db.prepare(
    `INSERT INTO customers (id, name, email, country, currency, credit_limit, open_balance, payment_terms) VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?)`
  );
  for (const [id, name, email, country, creditLimit, openBalance, terms] of SEED_CUSTOMERS) {
    insertCustomer.run(id, name, email, country, creditLimit, openBalance, terms);
  }
}

// SQLite adapter using better-sqlite3 (synchronous API wrapped in async)
async function createSqliteDb(dbPath: string): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedSqlite(db);

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
async function createPostgresDb(connectionString: string): Promise<Db> {
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
      for (const [id, sku, name, unit, listPrice, stock] of SEED_ITEMS) {
        await client.query(
          `INSERT INTO items (id, sku, name, unit, list_price, currency, stock) VALUES ($1, $2, $3, $4, $5, 'EUR', $6)`,
          [id, sku, name, unit, listPrice, stock]
        );
      }
      for (const [id, name, email, country, creditLimit, openBalance, terms] of SEED_CUSTOMERS) {
        await client.query(
          `INSERT INTO customers (id, name, email, country, currency, credit_limit, open_balance, payment_terms) VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $7)`,
          [id, name, email, country, creditLimit, openBalance, terms]
        );
      }
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

export async function createDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    console.error("[erp-mcp] using Postgres");
    return createPostgresDb(databaseUrl);
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
  return createSqliteDb(dbPath);
}
