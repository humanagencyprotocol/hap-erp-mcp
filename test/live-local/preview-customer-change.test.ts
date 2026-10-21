/**
 * preview_customer_change (§3.4, R4) and the D1 issuing guard (Andreas's
 * decision: reverse charge only with a stored VIES `valid`).
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice, create_credit_note, list_invoices } from "../../src/live/local/tools/invoices.js";
import { create_customer, preview_customer_change, update_customer_tax_data, addCustomer } from "../../src/live/local/tools/customers.js";
import { freshLocalCtx, cleanupDataDir, stubVies, withVies, INVOICE_ARGS_BASE, TODAY } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const AT = { name: "Drautal Maschinenbau GmbH", address_lines: ["Industriestraße 12", "9800 Spittal"], country: "AT", uid: "ATU12345678" };
const DE = { name: "Drautal Deutschland GmbH", address_lines: ["Hafenstraße 4", "20457 Hamburg"], country: "DE", uid: "DE123456789" };
const inv = (customer_id: string, number: string, vat_rate = 20) => ({
  customer_id, number, ...INVOICE_ARGS_BASE, lines: [{ description: "Beratung", qty: 1, unit_price: 100, vat_rate }], net_total: 100,
});

describe("preview_customer_change (R4)", () => {
  it("returns current data, changed fields, tax mode now/after, issued documents and the VAT check", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("pcc"));
    const c = await create_customer(db, AT, withVies(ctx));
    await create_invoice(db, inv(c.id, "2026-0001"), ctx);
    await create_invoice(db, inv(c.id, "2026-0002"), ctx);
    await create_credit_note(db, { invoice_id: "2026-0002", number: "2026-0003", document_date: TODAY, credit_total: 100, currency: "EUR", reason: "Storno" }, ctx);

    const p = await preview_customer_change(db, { id: c.id, ...DE }, withVies(ctx));
    expect(p).toMatchObject({
      current: { ...AT, revision: 1 },
      revision: 1,
      changed: ["name", "address_lines", "country", "uid"],
      uid_or_country_changed: true,
      tax_mode: { now: "normal", after: "reverse_charge" },
      issued_documents: { invoices: 2, credit_notes: 1, last_number: "2026-0003" },
      open_quotes: 0,
      vat_check: { uid: "DE123456789", format: "ok", vies: { status: "valid" }, duplicate: false, duplicate_of: null },
    });
  });

  it("an address-only change is not a uid/country change; the customer's own VAT ID is not a duplicate", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("pcc-addr"));
    const c = await create_customer(db, AT, withVies(ctx));
    const p = await preview_customer_change(db, { id: c.id, ...AT, address_lines: ["Neu 1"] }, withVies(ctx));
    expect(p).toMatchObject({ changed: ["address_lines"], uid_or_country_changed: false, issued_documents: { invoices: 0, credit_notes: 0, last_number: null } });
    expect(p.vat_check).toMatchObject({ duplicate: false });
  });

  it("absent uid = removing the VAT ID: no VAT check, no VIES call", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("pcc-nouid"));
    const c = await create_customer(db, AT, withVies(ctx));
    const p = await preview_customer_change(db, { id: c.id, name: AT.name, address_lines: AT.address_lines, country: "AT" }, withVies(ctx, stubVies({ ATU12345678: "throw" })));
    expect(p).toMatchObject({ changed: ["uid"], uid_or_country_changed: true, vat_check: null });
  });

  it("writes nothing", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("pcc-nowrite"));
    const c = await create_customer(db, AT, withVies(ctx));
    await preview_customer_change(db, { id: c.id, ...DE }, withVies(ctx));
    expect((await db.get<any>("SELECT revision, uid FROM local_customers WHERE id = ?", [c.id]))).toEqual({ revision: 1, uid: AT.uid });
  });
});

describe("D1: reverse charge is issued only with a stored VIES `valid`", () => {
  it("not_checked customer is saved, but a reverse-charge invoice is refused: confirm the VAT ID first — nothing issued", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("d1-notchecked"));
    const c = await create_customer(db, DE, withVies(ctx, stubVies({ DE123456789: "not_checked" })));
    expect(c.vies?.status).toBe("not_checked");
    await expect(create_invoice(db, inv(c.id, "2026-0100", 0), ctx)).rejects.toThrow(/reverse-charge invoice.*confirm the VAT ID first.*not checked.*Nothing was issued/);
    expect(await list_invoices(db, {})).toEqual([]);
    expect(await db.get<any>("SELECT COUNT(*) AS n FROM local_numbers")).toEqual({ n: 0 });
  });

  it("a CLI customer (never checked) is refused too", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("d1-never"));
    const c = await addCustomer(db, DE);
    await expect(create_invoice(db, inv(c.id, "2026-0101", 0), ctx)).rejects.toThrow(/confirm the VAT ID first.*never checked/);
  });

  it("after confirming (VIES valid) the invoice is issued; a credit note on it is EXEMPT once VIES is no longer valid, a new invoice is not", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("d1-confirm"));
    const c = await create_customer(db, DE, withVies(ctx, stubVies({ DE123456789: "not_checked" })));
    await update_customer_tax_data(db, { id: c.id, revision: 1, ...DE }, withVies(ctx)); // confirm path: same data, re-check → valid
    const issued = await create_invoice(db, inv(c.id, "2026-0102", 0), ctx);
    expect(issued.tax_mode).toBe("reverse_charge");

    // The address changes and VIES is unreachable at that moment → stored not_checked.
    await update_customer_tax_data(db, { id: c.id, revision: 2, ...DE, address_lines: ["Neu 1", "20457 Hamburg"] }, withVies(ctx, stubVies({ DE123456789: "not_checked" })));
    expect((await db.get<any>("SELECT vies_status FROM local_customers WHERE id = ?", [c.id])).vies_status).toBe("not_checked");

    // A correction of the issued invoice is accepted, with that invoice's tax treatment.
    const credit = { invoice_id: "2026-0102", number: "2026-0103", document_date: TODAY, credit_total: 100, currency: "EUR", reason: "Storno" };
    const cn = await create_credit_note(db, credit, ctx);
    expect(cn.vat_total).toBe(0);
    expect(cn.customer).toMatchObject({ address_lines: DE.address_lines, revision: 2 });

    // A NEW reverse-charge invoice is still refused.
    await expect(create_invoice(db, inv(c.id, "2026-0104", 0), ctx)).rejects.toThrow(/confirm the VAT ID first.*not checked.*Nothing was issued/);
  });

  it("a normal-VAT invoice is not affected by VIES status", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("d1-normal"));
    const c = await create_customer(db, AT, withVies(ctx, stubVies({ ATU12345678: "not_checked" })));
    expect((await create_invoice(db, inv(c.id, "2026-0104"), ctx)).tax_mode).toBe("normal");
  });
});
