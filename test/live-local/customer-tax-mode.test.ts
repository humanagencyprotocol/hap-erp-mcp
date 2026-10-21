/**
 * get_customer / find_customers carry the derived tax mode (the same
 * deriveTaxMode create_invoice uses), its label and the stored VIES status —
 * so the invoice card can fail a reverse-charge customer without VIES `valid`
 * before approval (D1) instead of the preview passing and execution refusing.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice, preview_invoice } from "../../src/live/local/tools/invoices.js";
import {
  create_customer, get_customer, find_customers, update_customer_tax_data, preview_customer_change, addCustomer, TAX_MODE_LABELS,
} from "../../src/live/local/tools/customers.js";
import { callTool } from "../../src/dispatch.js";
import { freshLocalCtx, cleanupDataDir, stubVies, withVies, INVOICE_ARGS_BASE, MUSTER_COMPANY_KLEINUNTERNEHMER } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const AT = { name: "Drautal GmbH", address_lines: ["Industriestraße 12"], country: "AT", uid: "ATU12345678" };
const DE = { name: "Kessler GmbH", address_lines: ["Hafenstraße 4"], country: "DE", uid: "DE123456789" };
const inv = (customer_id: string, number: string) => ({
  customer_id, number, ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 0 }], net_total: 100,
});

describe("tax_mode, tax_mode_label and vies_status on customer reads", () => {
  it("agrees with the tax mode create_invoice derives; vies_status is the stored one", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("tm-agree"));
    const de = await create_customer(db, DE, withVies(ctx, stubVies({ DE123456789: "not_checked" })));
    const at = await create_customer(db, AT, withVies(ctx));
    expect(await get_customer(db, { id: de.id }, ctx)).toMatchObject({
      tax_mode: "reverse_charge", tax_mode_label: "Reverse charge", vies_status: "not_checked",
    });
    expect(await get_customer(db, { id: at.id }, ctx)).toMatchObject({ tax_mode: "normal", tax_mode_label: "Normal VAT", vies_status: "valid" });

    // The card's rule (reverse charge without VIES valid) predicts execution: refused.
    await expect(create_invoice(db, inv(de.id, "2026-0001"), ctx)).rejects.toThrow(/confirm the VAT ID first/);
    // … and the preview still renders, so only the card check can show it before approval.
    await expect(preview_invoice(db, inv(de.id, "2026-0001"), ctx)).resolves.toBeTruthy();

    // After confirming: valid → issued with exactly the tax mode get_customer announced.
    await update_customer_tax_data(db, { id: de.id, revision: 1, ...DE }, withVies(ctx));
    const now = await get_customer(db, { id: de.id }, ctx);
    expect(now).toMatchObject({ tax_mode: "reverse_charge", vies_status: "valid" });
    expect((await create_invoice(db, inv(de.id, "2026-0002"), ctx)).tax_mode).toBe(now.tax_mode);
  });

  it("find_customers results carry the same fields", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("tm-find"));
    await create_customer(db, DE, withVies(ctx));
    const [c] = await find_customers(db, { uid: "DE123456789" }, ctx);
    expect(c).toMatchObject({ tax_mode: "reverse_charge", tax_mode_label: "Reverse charge", vies_status: "valid" });
  });

  it("never checked (CLI) → vies_status null; small-business company → kleinunternehmer with its label", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("tm-ku", MUSTER_COMPANY_KLEINUNTERNEHMER));
    const c = await addCustomer(db, AT);
    expect(await get_customer(db, { id: c.id }, ctx)).toMatchObject({
      vies_status: null, tax_mode: "kleinunternehmer", tax_mode_label: TAX_MODE_LABELS.kleinunternehmer,
    });
  });

  it("an old revision derives the tax mode from that revision's content; no VIES result", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("tm-old-rev"));
    const c = await create_customer(db, AT, withVies(ctx));
    await update_customer_tax_data(db, { id: c.id, revision: 1, ...DE }, withVies(ctx));
    expect(await get_customer(db, { id: c.id, revision: 1 }, ctx)).toMatchObject({ tax_mode: "normal", vies_status: null });
    expect(await get_customer(db, { id: c.id }, ctx)).toMatchObject({ tax_mode: "reverse_charge", vies_status: "valid" });
  });

  it("write tools return the same fields; preview_customer_change labels now/after", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("tm-writes"));
    const c = await create_customer(db, AT, withVies(ctx));
    expect(c).toMatchObject({ tax_mode: "normal", tax_mode_label: "Normal VAT" });
    const p = await preview_customer_change(db, { id: c.id, ...DE }, withVies(ctx));
    expect(p.tax_mode).toEqual({ now: "normal", after: "reverse_charge", now_label: "Normal VAT", after_label: "Reverse charge" });
  });

  it("the MCP dispatch path returns them (get_customer through callTool)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("tm-dispatch"));
    const c = await create_customer(db, DE, withVies(ctx, stubVies({ DE123456789: "not_checked" })));
    const { writeFileSync } = await import("fs");
    const { join } = await import("path");
    const company = join(dataDir, "company.json");
    writeFileSync(company, JSON.stringify({
      ...ctx.company, address: { ...ctx.company.address }, bank: { ...ctx.company.bank },
    }));
    const env = { ERP_LIVE_ADAPTER: "local", ERP_LIVE_COMPANY_FILE: company, HAP_DATA_DIR: dataDir, ERP_VIES: "off" } as NodeJS.ProcessEnv;
    expect(await callTool(db, "live", "get_customer", { id: c.id }, env)).toMatchObject({
      tax_mode: "reverse_charge", tax_mode_label: "Reverse charge", vies_status: "not_checked",
    });
  });
});
