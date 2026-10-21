import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice, create_credit_note } from "../../src/live/local/tools/invoices.js";
import { exportInvoicesToDir, collectExportRows } from "../../src/live/local/export.js";
import { freshLocalCtx, cleanupDataDir, seedAtCustomer, changeCustomerTaxData, INVOICE_ARGS_BASE, TODAY } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
let outDir: string;

afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("export-invoices", () => {
  it("writes a CSV with one row per invoice/credit note and a copy of each archived PDF", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("export"));
    const cust = await seedAtCustomer(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0001", ...INVOICE_ARGS_BASE, lines: [{ description: "Beratung", qty: 1, unit_price: 9000, vat_rate: 20 }], net_total: 9000 },
      ctx
    );
    await create_credit_note(
      db,
      { invoice_id: invoice.id, number: "2026-G0001", document_date: TODAY, credit_total: 1500, currency: "EUR", reason: "test", lines: [{ description: "Reduktion", qty: 1, unit_price: 1500, vat_rate: 20 }] },
      ctx
    );

    const month = new Date(invoice.issued_at).toISOString().slice(0, 7);
    outDir = mkdtempSync(join(tmpdir(), "erp-local-export-out-"));
    const count = await exportInvoicesToDir(db, month, outDir);
    expect(count).toBe(2);

    const csvPath = join(outDir, `invoices-${month}.csv`);
    expect(existsSync(csvPath)).toBe(true);
    const csv = readFileSync(csvPath, "utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("number,date,kind,customer,uid,country,net,vat,gross,tax_mode,credited_invoice");
    expect(lines).toHaveLength(3); // header + invoice + credit note

    const invoiceLine = lines.find((l) => l.startsWith("2026-0001,"))!;
    expect(invoiceLine).toContain("invoice");
    expect(invoiceLine).toContain("Drautal Maschinenbau GmbH");
    expect(invoiceLine).toContain("ATU12345678");
    expect(invoiceLine).toContain(",9000,1800,10800,normal,");

    const creditNoteLine = lines.find((l) => l.startsWith("2026-G0001,"))!;
    expect(creditNoteLine).toContain("credit_note");
    expect(creditNoteLine).toContain(",-1500,-300,-1800,,2026-0001");

    expect(existsSync(join(outDir, "2026-0001.pdf"))).toBe(true);
    expect(existsSync(join(outDir, "2026-G0001.pdf"))).toBe(true);
  });

  it("excludes documents outside the requested month", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("export-month-filter"));
    const cust = await seedAtCustomer(db);
    await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0001", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 },
      ctx
    );
    outDir = mkdtempSync(join(tmpdir(), "erp-local-export-out2-"));
    const count = await exportInvoicesToDir(db, "2020-01", outDir);
    expect(count).toBe(0);
  });

  it("R1: prints each document's customer as issued (snapshot), not the customer's current data", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("export-snapshot"));
    const cust = await seedAtCustomer(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0001", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 },
      ctx
    );
    await changeCustomerTaxData(db, cust.id, {
      name: "Drautal AG", address_lines: ["Bahnhofstraße 1", "9500 Villach"], country: "AT", uid: "ATU87654321",
    }, ctx);
    await create_credit_note(db, { invoice_id: invoice.id, number: "2026-G0001", document_date: TODAY, credit_total: 100, currency: "EUR", reason: "Storno" }, ctx);
    await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0002", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 },
      ctx
    );

    const rows = await collectExportRows(db, new Date(invoice.issued_at).toISOString().slice(0, 7));
    const by = Object.fromEntries(rows.map((r) => [r.number, r]));
    expect(by["2026-0001"]).toMatchObject({ customer: "Drautal Maschinenbau GmbH", uid: "ATU12345678", country: "AT" });
    // The credit note corrects the old invoice: it carries that invoice's snapshot.
    expect(by["2026-G0001"]).toMatchObject({ customer: "Drautal Maschinenbau GmbH", uid: "ATU12345678" });
    expect(by["2026-0002"]).toMatchObject({ customer: "Drautal AG", uid: "ATU87654321" });
  });
});
