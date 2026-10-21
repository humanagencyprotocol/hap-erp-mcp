/** Shared test fixtures for live mode's "local" adapter — never used outside test/. */
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync, cpSync, readFileSync } from "fs";
import { createLocalDb } from "../../src/live/local/db.js";
import { parseLiveCompany, type LiveCompany } from "../../src/live/local/company-file.js";
import { loadTemplateFile, DEFAULT_TEMPLATE_PATH } from "../../src/live/local/template.js";
import { addCustomer } from "../../src/live/local/tools/customers.js";
import { todayInTimezone } from "../../src/live/local/date.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import type { Db } from "../../src/db.js";

// MUSTER = placeholder test data, never real company data.
export const MUSTER_COMPANY: LiveCompany = parseLiveCompany({
  name: "Suveren",
  owner: "Andreas Schadauer MUSTER",
  address: { street: "MUSTER-Straße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
  uid: "ATU00000000",
  email: "andreas@sublin.app",
  web: "www.suveren.ai",
  register: null,
  bank: { name: "MUSTER Bank", iban: "AT00 0000 0000 0000 0000", bic: "MUSTERBIC" },
  default_payment_term_days: 14,
  vat_mode: "normal",
});

export const MUSTER_COMPANY_KLEINUNTERNEHMER: LiveCompany = { ...MUSTER_COMPANY, vat_mode: "kleinunternehmer" };

export const DEFAULT_TEMPLATE = loadTemplateFile(DEFAULT_TEMPLATE_PATH);

export function tmpDataDir(label: string): string {
  return join(tmpdir(), `erp-local-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

export async function freshLocalCtx(label: string, company: LiveCompany = MUSTER_COMPANY): Promise<{ db: Db; ctx: LocalCtx; dataDir: string }> {
  const dataDir = tmpDataDir(label);
  const db = await createLocalDb(join(dataDir, "erp-local.sqlite"));
  return { db, ctx: { company, template: DEFAULT_TEMPLATE, dataDir }, dataDir };
}

export function cleanupDataDir(dataDir: string): void {
  rmSync(dataDir, { recursive: true, force: true });
}

export async function seedAtCustomer(db: Db) {
  return addCustomer(db, {
    name: "Drautal Maschinenbau GmbH",
    address_lines: ["Industriestraße 12", "9800 Spittal an der Drau", "Österreich"],
    country: "AT",
    uid: "ATU12345678",
    email: "buchhaltung@drautal.example",
  });
}

export async function seedAtCustomerNoUid(db: Db) {
  return addCustomer(db, {
    name: "Huber Werbetechnik e.U.",
    address_lines: ["Hauptplatz 3", "4020 Linz", "Österreich"],
    country: "AT",
    email: "huber@werbetechnik.example",
  });
}

export async function seedDeCustomer(db: Db) {
  return addCustomer(db, {
    name: "Kessler Anlagenbau GmbH",
    address_lines: ["Hafenstraße 4", "20457 Hamburg", "Deutschland"],
    country: "DE",
    uid: "DE123456789",
    email: "ap@kessler.example",
  });
}

export async function seedDeCustomerNoUid(db: Db) {
  return addCustomer(db, {
    name: "Privatkunde Schmidt",
    address_lines: ["Musterweg 1", "10115 Berlin", "Deutschland"],
    country: "DE",
    email: "schmidt@example.de",
  });
}

// MUSTER_COMPANY declares no `timezone`, so it defaults to Europe/Vienna
// (see company-file.ts) — this must match, or create_invoice/create_credit_note's
// "document_date must be today" check would spuriously refuse every fixture.
export const TODAY = todayInTimezone("Europe/Vienna");

export const INVOICE_ARGS_BASE = {
  document_date: TODAY,
  service_period: { from: "2026-10-06", to: "2026-10-24" },
  currency: "EUR",
};

// --- ERP Local in production (contract §6, §8): migration fixture + customer change ---

/** A Local DB + archive written by erp-mcp 0.9.5 (see test/fixtures/local-0.9.5/). */
export const LOCAL_095_FIXTURE_DIR = join(__dirname, "..", "fixtures", "local-0.9.5");

/**
 * Materialises the 0.9.5 fixture into `dataDir`: the archived PDFs under
 * erp-local-archive/, and erp-local.sqlite built from the checked-in SQL
 * with raw better-sqlite3 — i.e. exactly as 0.9.5 left it, no migration run.
 * `before` runs on the raw DB before it is closed (e.g. to add a duplicate).
 */
export async function materialiseLocal095Fixture(
  dataDir: string,
  before?: (raw: import("better-sqlite3").Database) => void
): Promise<string> {
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(LOCAL_095_FIXTURE_DIR, "erp-local-archive"), join(dataDir, "erp-local-archive"), { recursive: true });
  const sql = readFileSync(join(LOCAL_095_FIXTURE_DIR, "local-db.sql"), "utf8").split("__DATA_DIR__").join(dataDir);
  const dbPath = join(dataDir, "erp-local.sqlite");
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(dbPath);
  raw.exec(sql);
  before?.(raw);
  raw.close();
  return dbPath;
}

/** The original requests the fixture's documents were issued with. */
export function local095Requests(): { invoices: Record<string, any>; credit_notes: Record<string, any> } {
  return JSON.parse(readFileSync(join(LOCAL_095_FIXTURE_DIR, "requests.json"), "utf8"));
}

/**
 * Stand-in for update_customer_tax_data (Part A2) until it exists: replaces
 * the customer's tax data and moves it to the next revision, directly in SQL.
 */
export async function changeCustomerTaxData(
  db: Db, id: string, data: { name: string; address_lines: string[]; country: string; uid: string | null }
): Promise<void> {
  await db.run(
    `UPDATE local_customers SET name = ?, address_lines = ?, country = ?, uid = ?, revision = revision + 1,
       updated_at = datetime('now') WHERE id = ?`,
    [data.name, JSON.stringify(data.address_lines), data.country, data.uid, id]
  );
}
