/** Shared test fixtures for live mode's "local" adapter — never used outside test/. */
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
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
