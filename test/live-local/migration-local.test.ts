/**
 * R12 + R1 on an existing DB (docs/local-production-contract.md §6, §8): a
 * Local DB written by 0.9.5 (test/fixtures/local-0.9.5, generated once with
 * the 0.9.5 code) opens, keeps every existing value, gets customer snapshots
 * marked `migrated`, keeps every archived PDF verifiable, and a second open
 * changes nothing. A DB holding two customers with one VAT ID still opens.
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { createLocalDb } from "../../src/live/local/db.js";
import { preview_invoice, create_credit_note, get_document, get_invoice } from "../../src/live/local/tools/invoices.js";
import type { Db } from "../../src/db.js";
import {
  tmpDataDir, cleanupDataDir, materialiseLocal095Fixture, local095Requests, changeCustomerTaxData,
  MUSTER_COMPANY, DEFAULT_TEMPLATE, TODAY,
} from "./fixtures.js";

const OLD_TABLES = ["local_customers", "local_numbers", "local_invoices", "local_invoice_lines", "local_credit_notes", "local_credit_note_lines"];

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const d of dirs.splice(0)) cleanupDataDir(d);
});

async function rawDump(dbPath: string, tables?: string[]): Promise<Record<string, unknown[]>> {
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(dbPath, { readonly: true });
  const names = tables ?? (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[]).map((r) => r.name);
  const out: Record<string, unknown[]> = {
    __schema: raw.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all(),
  };
  for (const t of names) out[t] = raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  raw.close();
  return out;
}

async function openFixture(label: string, before?: Parameters<typeof materialiseLocal095Fixture>[1], log?: (m: string) => void) {
  const dataDir = tmpDataDir(label);
  dirs.push(dataDir);
  const dbPath = await materialiseLocal095Fixture(dataDir, before);
  const pre = await rawDump(dbPath, OLD_TABLES);
  const db = await createLocalDb(dbPath, { log: log ?? (() => {}) });
  dbs.push(db);
  const ctx = { company: MUSTER_COMPANY, template: DEFAULT_TEMPLATE, dataDir };
  return { dataDir, dbPath, db, ctx, pre };
}

describe("0.9.5 Local DB → current schema", () => {
  it("keeps every existing value; only the new columns are filled", async () => {
    const { db, pre } = await openFixture("mig-values");
    for (const table of OLD_TABLES) {
      const after = await db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
      expect(after.length).toBe(pre[table].length);
      after.forEach((row, i) => {
        for (const [col, value] of Object.entries(pre[table][i] as Record<string, unknown>)) {
          expect(row[col], `${table}[${i}].${col}`).toEqual(value);
        }
      });
    }
  });

  it("snapshots every old invoice and credit note as 'migrated' with the customer's values", async () => {
    const { db } = await openFixture("mig-snapshot");
    const invoices = await db.all<any>(
      `SELECT i.*, c.name AS c_name, c.address_lines AS c_addr, c.country AS c_country, c.uid AS c_uid
       FROM local_invoices i JOIN local_customers c ON c.id = i.customer_id`
    );
    expect(invoices.length).toBe(3);
    for (const i of invoices) {
      expect(i.customer_snapshot_source).toBe("migrated");
      expect(i.customer_revision).toBe(1);
      expect([i.customer_name, i.customer_address_lines, i.customer_country, i.customer_uid]).toEqual([i.c_name, i.c_addr, i.c_country, i.c_uid]);
    }
    const notes = await db.all<any>(
      `SELECT n.*, i.customer_name AS i_name, i.customer_address_lines AS i_addr, i.customer_country AS i_country, i.customer_uid AS i_uid
       FROM local_credit_notes n JOIN local_invoices i ON i.id = n.invoice_id`
    );
    expect(notes.length).toBe(2);
    for (const n of notes) {
      expect(n.customer_snapshot_source).toBe("migrated");
      expect([n.customer_name, n.customer_address_lines, n.customer_country, n.customer_uid]).toEqual([n.i_name, n.i_addr, n.i_country, n.i_uid]);
    }
    const inv = await get_invoice(db, { id: "F-2026-002" });
    expect(inv.customer).toEqual({
      name: "Kessler Anlagenbau GmbH", address_lines: ["Hafenstraße 4", "20457 Hamburg", "Deutschland"],
      country: "DE", uid: "DE123456789", revision: 1, source: "migrated",
    });
  });

  it("every archived PDF still verifies through get_document", async () => {
    const { db } = await openFixture("mig-verify");
    const rows = await db.all<{ number: string; archive_sha256: string }>("SELECT number, archive_sha256 FROM local_invoices");
    for (const r of rows) expect(((await get_document(db, { kind: "invoice-pdf", id: r.number })) as any).sha256).toBe(r.archive_sha256);
    const notes = await db.all<{ number: string; archive_sha256: string }>("SELECT number, archive_sha256 FROM local_credit_notes");
    for (const r of notes) expect(((await get_document(db, { kind: "credit-note-pdf", id: r.number })) as any).sha256).toBe(r.archive_sha256);
  });

  it("the snapshot render path reproduces the 0.9.5 archived invoices byte for byte", async () => {
    const { db, ctx } = await openFixture("mig-bytes");
    const { invoices } = local095Requests();
    for (const [number, args] of Object.entries(invoices)) {
      const stored = await db.get<{ archive_sha256: string }>("SELECT archive_sha256 FROM local_invoices WHERE number = ?", [number]);
      const preview = (await preview_invoice(db, args, ctx)) as any;
      expect(preview.sha256, number).toBe(stored!.archive_sha256);
    }
  });

  it("backfills revision 1 of every customer into local_master_revisions", async () => {
    const { db } = await openFixture("mig-revisions");
    const revs = await db.all<any>(`SELECT * FROM local_master_revisions WHERE entity = 'customer' ORDER BY entity_id`);
    expect(revs.map((r) => [r.entity_id, r.revision])).toEqual([["c-at-0001", 1], ["c-at-0002", 1], ["c-de-0001", 1]]);
    expect(JSON.parse(revs[0].content)).toEqual({
      name: "Drautal Maschinenbau GmbH", address_lines: ["Industriestraße 12", "9800 Spittal an der Drau", "Österreich"],
      country: "AT", uid: "ATU12345678", email: "buchhaltung@drautal.example", crm_contact_id: null,
    });
  });

  it("a second open is a no-op", async () => {
    const { db, dbPath } = await openFixture("mig-twice");
    await db.close();
    dbs.splice(dbs.indexOf(db), 1);
    const first = await rawDump(dbPath);
    const again = await createLocalDb(dbPath, { log: () => {} });
    await again.close();
    expect(await rawDump(dbPath)).toEqual(first);
  });
});

describe("credit note on a pre-migration invoice (AM3)", () => {
  it("renders the migrated snapshot, not the customer's data changed after migration", async () => {
    const credit = { invoice_id: "F-2026-003", number: "F-2026-006", document_date: TODAY, credit_total: 150, currency: "EUR", reason: "Storno" };
    const changed = await openFixture("mig-cn-changed");
    await changeCustomerTaxData(changed.db, "c-at-0002", {
      name: "Huber Werbetechnik GmbH", address_lines: ["Neue Gasse 9", "4020 Linz", "Österreich"], country: "AT", uid: "ATU99999999",
    });
    const cn = await create_credit_note(changed.db, credit, changed.ctx);
    const twin = await openFixture("mig-cn-twin");
    const twinCn = await create_credit_note(twin.db, credit, twin.ctx);
    expect(cn.archive_sha256).toBe(twinCn.archive_sha256);
    expect(cn.customer).toEqual({
      name: "Huber Werbetechnik e.U.", address_lines: ["Hauptplatz 3", "4020 Linz", "Österreich"],
      country: "AT", uid: null, revision: 1, source: "migrated",
    });
  });
});

describe("duplicate VAT IDs in an existing DB (M-A1)", () => {
  const indexNames = async (db: Db) =>
    (await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'local_customers'`)).map((r) => r.name);

  it("without duplicates: both partial unique indexes exist", async () => {
    const { db } = await openFixture("mig-idx");
    expect(await indexNames(db)).toEqual(expect.arrayContaining(["local_customers_uid_unique", "local_customers_crm_contact_unique"]));
  });

  it("with duplicates: the DB opens, the VAT-ID index is skipped and the colliding ids are logged", async () => {
    const logs: string[] = [];
    const { db } = await openFixture(
      "mig-dup",
      (raw) => raw.prepare(`INSERT INTO local_customers (id, name, address_lines, country, uid) VALUES ('c-at-dup', 'Drautal Filiale', '["Filialweg 1"]', 'AT', 'ATU12345678')`).run(),
      (m) => logs.push(m)
    );
    const names = await indexNames(db);
    expect(names).not.toContain("local_customers_uid_unique");
    expect(names).toContain("local_customers_crm_contact_unique");
    expect(logs.join("\n")).toMatch(/ATU12345678 \((c-at-0001, c-at-dup|c-at-dup, c-at-0001)\)/);
    expect(((await db.get<any>(`SELECT COUNT(*) AS n FROM local_invoices WHERE customer_snapshot_source = 'migrated'`))).n).toBe(3);
  });
});

describe("a fresh DB and a migrated one have the same schema", () => {
  it("same tables, same columns, same indexes", async () => {
    const { dbPath } = await openFixture("mig-schema");
    const freshDir = tmpDataDir("fresh-schema");
    dirs.push(freshDir);
    const fresh = await createLocalDb(join(freshDir, "erp-local.sqlite"));
    dbs.push(fresh);
    const shape = async (db: Db) => {
      const objs = await db.all<{ type: string; name: string; tbl_name: string }>(
        `SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY name`
      );
      const cols: Record<string, unknown> = {};
      for (const o of objs.filter((x) => x.type === "table")) {
        cols[o.name] = (await db.all<any>(`PRAGMA table_info(${o.name})`)).map((c) => [c.name, c.type, c.notnull, c.dflt_value]);
      }
      return { objs, cols };
    };
    const migrated = dbs.find((d) => d !== fresh)!;
    expect(await shape(migrated)).toEqual(await shape(fresh));
    expect(dbPath).toBeTruthy();
  });
});
