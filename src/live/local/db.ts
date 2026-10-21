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

// Tables added for ERP Local in production (docs/local-production-contract.md §6).
// The base SCHEMA above stays exactly as 0.9.5 wrote it; new columns on its
// tables come from ADDED_COLUMNS, so a fresh DB and a migrated one end up with
// the same schema through the same code path.
const NEW_TABLES = `
-- Records one-time data steps (M-A2) so each runs exactly once.
CREATE TABLE IF NOT EXISTS local_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- M-A3: every revision of a customer or catalogue item, content as JSON.
CREATE TABLE IF NOT EXISTS local_master_revisions (
  entity TEXT NOT NULL CHECK(entity IN ('customer','item')),
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  ticket_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, revision)
);

-- M-B1 (Part B): quotes have their own number series and never touch local_numbers.
CREATE TABLE IF NOT EXISTS local_quote_numbers (
  number TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  quote_id TEXT NOT NULL,
  UNIQUE(year, seq)
);

CREATE TABLE IF NOT EXISTS local_quotes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES local_customers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','converted','cancelled')),
  currency TEXT NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  net_total REAL NOT NULL,
  valid_until TEXT,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  sent_at TEXT,
  document_date TEXT,
  archive_path TEXT,
  archive_sha256 TEXT,
  template_id TEXT,
  template_version TEXT,
  template_fingerprint TEXT,
  invoice_id TEXT REFERENCES local_invoices(id),
  ticket_id TEXT
);
`;

const NEW_TABLES_2 = `
CREATE TABLE IF NOT EXISTS local_quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES local_quotes(id) ON DELETE CASCADE,
  item_id TEXT,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'Stk.',
  unit_price REAL NOT NULL,
  vat_rate REAL NOT NULL,
  list_price REAL,
  item_revision INTEGER,
  line_net REAL NOT NULL
);

-- Each quote revision snapshots its lines and the customer (R1).
CREATE TABLE IF NOT EXISTS local_quote_revisions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES local_quotes(id),
  revision INTEGER NOT NULL,
  lines TEXT NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  net_total REAL NOT NULL,
  currency TEXT NOT NULL,
  valid_until TEXT,
  notes TEXT,
  customer_name TEXT NOT NULL,
  customer_address_lines TEXT NOT NULL,
  customer_country TEXT NOT NULL,
  customer_uid TEXT,
  customer_revision INTEGER NOT NULL,
  customer_snapshot_source TEXT NOT NULL DEFAULT 'issued',
  ticket_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(quote_id, revision)
);

-- M-C1 (Part C): catalogue items. Revisions go to local_master_revisions (entity 'item').
CREATE TABLE IF NOT EXISTS local_items (
  id TEXT PRIMARY KEY,
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('service','product')),
  unit TEXT NOT NULL,
  list_price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  vat_rate REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS local_items_sku_unique ON local_items(sku) WHERE sku IS NOT NULL;
`;

/**
 * New columns on the 0.9.5 tables — guarded `ALTER TABLE … ADD COLUMN`
 * (checked against `PRAGMA table_info` first), the simulator's pattern. All
 * nullable or defaulted: old rows keep every existing value.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // M-A1: customers gain revisions, a CRM link and the last stored VIES result.
  { table: "local_customers", column: "crm_contact_id", ddl: "TEXT" },
  { table: "local_customers", column: "revision", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "local_customers", column: "updated_at", ddl: "TEXT" },
  { table: "local_customers", column: "vies_status", ddl: "TEXT" },
  { table: "local_customers", column: "vies_reason", ddl: "TEXT" },
  { table: "local_customers", column: "vies_checked_at", ddl: "TEXT" },
  { table: "local_customers", column: "vies_request_id", ddl: "TEXT" },
  { table: "local_customers", column: "vies_name", ddl: "TEXT" },
  { table: "local_customers", column: "vies_address", ddl: "TEXT" },
  // M-A2: customer snapshot as issued (R1).
  ...["local_invoices", "local_credit_notes"].flatMap((table) => [
    { table, column: "customer_name", ddl: "TEXT" },
    { table, column: "customer_address_lines", ddl: "TEXT" },
    { table, column: "customer_country", ddl: "TEXT" },
    { table, column: "customer_uid", ddl: "TEXT" },
    { table, column: "customer_revision", ddl: "INTEGER" },
    { table, column: "customer_snapshot_source", ddl: "TEXT" },
  ]),
  // M-A4: quote link on invoices; catalogue link on document lines.
  { table: "local_invoices", column: "quote_id", ddl: "TEXT" },
  { table: "local_invoices", column: "quote_revision", ddl: "INTEGER" },
  ...["local_invoice_lines", "local_credit_note_lines"].flatMap((table) => [
    { table, column: "item_id", ddl: "TEXT" },
    { table, column: "list_price", ddl: "REAL" },
    { table, column: "item_revision", ddl: "INTEGER" },
  ]),
];

/** Default path: <HAP_DATA_DIR ?? ~/.hap>/erp-local.sqlite — kept separate from the simulation's erp.db. */
export function resolveLocalDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ERP_LOCAL_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const dataDir = env.HAP_DATA_DIR ?? join(homedir(), ".hap");
  return join(dataDir, "erp-local.sqlite");
}

type RawDb = import("better-sqlite3").Database;

/**
 * Brings any Local DB — fresh, or written by 0.9.5 — to the current schema.
 * Additive and idempotent: a second run changes nothing. Never touches
 * local_numbers, archive files, archive_sha256 or template_* of issued rows.
 * Logs go to stderr (stdout is the MCP stdio channel).
 */
export function migrateLocalSchema(db: RawDb, log: (msg: string) => void): void {
  db.transaction(() => {
    db.exec(SCHEMA);
    db.exec(NEW_TABLES);
    db.exec(NEW_TABLES_2);
  })();

  db.transaction(() => {
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS local_customers_crm_contact_unique ON local_customers(crm_contact_id) WHERE crm_contact_id IS NOT NULL`
    );
  })();

  ensureUidIndex(db, log);
  snapshotIssuedDocumentsOnce(db);
  backfillCustomerRevisions(db);
}

/**
 * M-A1: one customer per VAT ID. A DB written by 0.9.5 may already hold two
 * customers with the same `uid` (nothing refused it then). Such a DB must
 * still open: the index is skipped and the colliding ids logged; the
 * connector-level duplicate check still refuses NEW duplicates. The check
 * re-runs on every start, so the index appears once the duplicates are gone.
 */
function ensureUidIndex(db: RawDb, log: (msg: string) => void): void {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'local_customers_uid_unique'`)
    .get();
  if (exists) return;
  const dups = db
    .prepare(
      `SELECT uid, group_concat(id, ', ') AS ids FROM local_customers WHERE uid IS NOT NULL GROUP BY uid HAVING COUNT(*) > 1`
    )
    .all() as Array<{ uid: string; ids: string }>;
  if (dups.length > 0) {
    log(
      `local DB: unique VAT-ID index not created — customers share a VAT ID: ` +
        dups.map((d) => `${d.uid} (${d.ids})`).join("; ") +
        `. New duplicates are still refused.`
    );
    return;
  }
  db.exec(`CREATE UNIQUE INDEX local_customers_uid_unique ON local_customers(uid) WHERE uid IS NOT NULL`);
}

/**
 * M-A2 (once, recorded in local_schema_migrations): snapshot the customer on
 * every invoice and credit note issued before snapshots existed.
 *
 * For those documents the archived PDF (write-once, sha-verified) stays the
 * legal original. The `migrated` snapshot is a best-effort copy of the
 * customer row as it is at migration time — the closest record there is,
 * since 0.9.5 kept no history. A credit note on a pre-migration invoice
 * renders this migrated snapshot. Credit notes copy their invoice's snapshot
 * (they correct that document), not the customer row.
 */
function snapshotIssuedDocumentsOnce(db: RawDb): void {
  const done = db.prepare(`SELECT 1 FROM local_schema_migrations WHERE id = 'M-A2'`).get();
  if (done) return;
  const fromCustomer = (col: string) =>
    `(SELECT c.${col} FROM local_customers c WHERE c.id = local_invoices.customer_id)`;
  const fromInvoice = (col: string) =>
    `(SELECT i.${col} FROM local_invoices i WHERE i.id = local_credit_notes.invoice_id)`;
  db.transaction(() => {
    db.exec(`
      UPDATE local_invoices SET
        customer_name = ${fromCustomer("name")},
        customer_address_lines = ${fromCustomer("address_lines")},
        customer_country = ${fromCustomer("country")},
        customer_uid = ${fromCustomer("uid")},
        customer_revision = 1,
        customer_snapshot_source = 'migrated'
      WHERE customer_snapshot_source IS NULL;
      UPDATE local_credit_notes SET
        customer_name = ${fromInvoice("customer_name")},
        customer_address_lines = ${fromInvoice("customer_address_lines")},
        customer_country = ${fromInvoice("customer_country")},
        customer_uid = ${fromInvoice("customer_uid")},
        customer_revision = 1,
        customer_snapshot_source = 'migrated'
      WHERE customer_snapshot_source IS NULL;
    `);
    db.prepare(`INSERT INTO local_schema_migrations (id, applied_at) VALUES ('M-A2', ?)`).run(new Date().toISOString());
  })();
}

/**
 * M-A3 backfill: every customer has a local_master_revisions row for its
 * current revision (content = the customer record). Runs on every start and
 * inserts only what is missing, so it is a no-op once filled and also covers
 * customers added by the CLI before it writes revision rows itself.
 */
function backfillCustomerRevisions(db: RawDb): void {
  db.exec(`
    INSERT INTO local_master_revisions (entity, entity_id, revision, content, ticket_id, created_at)
    SELECT 'customer', c.id, c.revision,
      json_object('name', c.name, 'address_lines', json(c.address_lines), 'country', c.country,
                  'uid', c.uid, 'email', c.email, 'crm_contact_id', c.crm_contact_id),
      NULL, COALESCE(c.updated_at, c.created_at, datetime('now'))
    FROM local_customers c
    WHERE NOT EXISTS (
      SELECT 1 FROM local_master_revisions r
      WHERE r.entity = 'customer' AND r.entity_id = c.id AND r.revision = c.revision
    )
  `);
}

export interface CreateLocalDbOptions {
  /** Where migration notices go; default stderr. */
  log?: (msg: string) => void;
}

export async function createLocalDb(dbPath: string, opts: CreateLocalDbOptions = {}): Promise<Db> {
  const dir = dbPath.includes("/") ? dbPath.slice(0, dbPath.lastIndexOf("/")) : "";
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  migrateLocalSchema(db, opts.log ?? ((msg) => console.error(`[erp-mcp] ${msg}`)));

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
