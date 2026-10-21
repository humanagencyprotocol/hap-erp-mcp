/**
 * R1 — snapshot first (docs/local-production-contract.md §3.6). Invoices and
 * credit notes freeze the customer's name, address, country and VAT ID as
 * issued and render only from that. The proof does not scrape PDF text
 * (pdfmake draws glyph ids, see pdf-render.test.ts): rendering is
 * deterministic, so a credit note issued after the customer changed must be
 * byte-identical to the same credit note issued in a twin DB where the
 * customer never changed — and must differ from one issued to the new data.
 * Without the snapshot (rendering from the current customer row) the first
 * comparison fails.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import {
  create_invoice, preview_invoice, create_credit_note, get_invoice, list_invoices, get_credit_note,
} from "../../src/live/local/tools/invoices.js";
import { addCustomer } from "../../src/live/local/tools/customers.js";
import { freshLocalCtx, cleanupDataDir, changeCustomerTaxData, INVOICE_ARGS_BASE, TODAY } from "./fixtures.js";

const OLD = {
  id: "cust-snap-1",
  name: "Drautal Maschinenbau GmbH",
  address_lines: ["Industriestraße 12", "9800 Spittal an der Drau", "Österreich"],
  country: "AT",
  uid: "ATU12345678",
};
const NEW = {
  name: "Drautal Maschinenbau AG",
  address_lines: ["Bahnhofstraße 1", "9500 Villach", "Österreich"],
  country: "AT",
  uid: "ATU87654321",
};

const opened: Array<{ db: Db; dataDir: string }> = [];
afterEach(async () => {
  for (const o of opened.splice(0)) {
    await o.db.close();
    cleanupDataDir(o.dataDir);
  }
});

async function world(label: string, customer: Record<string, unknown> = OLD): Promise<{ db: Db; ctx: LocalCtx }> {
  const w = await freshLocalCtx(label);
  opened.push({ db: w.db, dataDir: w.dataDir });
  await addCustomer(w.db, { ...customer, id: OLD.id, email: "buchhaltung@drautal.example" });
  return { db: w.db, ctx: w.ctx };
}

const invoiceArgs = {
  customer_id: OLD.id, number: "2026-0100", ...INVOICE_ARGS_BASE,
  lines: [{ description: "Beratung", qty: 2, unit_price: 500, vat_rate: 20 }], net_total: 1000,
};
const creditArgs = {
  invoice_id: "2026-0100", number: "2026-0101", document_date: TODAY, credit_total: 1000, currency: "EUR", reason: "Storno",
};

const oldSnapshot = { name: OLD.name, address_lines: OLD.address_lines, country: OLD.country, uid: OLD.uid, revision: 1 };

describe("create_invoice stores and returns the customer snapshot", () => {
  it("get_invoice / list_invoices return customer as issued, source 'issued'", async () => {
    const { db, ctx } = await world("snap-issued");
    const issued = await create_invoice(db, invoiceArgs, ctx);
    expect(issued.customer).toEqual({ ...oldSnapshot, source: "issued" });
    expect((issued as any).customer_name).toBeUndefined();
    const [listed] = await list_invoices(db, {});
    expect(listed.customer).toEqual({ ...oldSnapshot, source: "issued" });
  });

  it("a later customer change does not reach get_invoice", async () => {
    const { db, ctx } = await world("snap-get-after-change");
    await create_invoice(db, invoiceArgs, ctx);
    await changeCustomerTaxData(db, OLD.id, NEW);
    const after = await get_invoice(db, { id: "2026-0100" });
    expect(after.customer).toEqual({ ...oldSnapshot, source: "issued" });
  });
});

describe("credit note on an old invoice renders the invoice's snapshot, not today's customer", () => {
  it("is byte-identical to the twin where the customer never changed, and differs from the new data", async () => {
    // Changed after issuing.
    const changed = await world("snap-cn-changed");
    await create_invoice(changed.db, invoiceArgs, changed.ctx);
    await changeCustomerTaxData(changed.db, OLD.id, NEW);
    const cn = await create_credit_note(changed.db, creditArgs, changed.ctx);

    // Twin: same requests, customer never changed.
    const twin = await world("snap-cn-twin");
    await create_invoice(twin.db, invoiceArgs, twin.ctx);
    const twinCn = await create_credit_note(twin.db, creditArgs, twin.ctx);

    // Control: the customer had the NEW data all along.
    const control = await world("snap-cn-control", { ...NEW });
    await create_invoice(control.db, invoiceArgs, control.ctx);
    const controlCn = await create_credit_note(control.db, creditArgs, control.ctx);

    expect(controlCn.archive_sha256).not.toBe(twinCn.archive_sha256); // the comparison can discriminate
    expect(cn.archive_sha256).toBe(twinCn.archive_sha256);
    expect(cn.customer).toEqual({ ...oldSnapshot, source: "issued" });
    expect((await get_credit_note(changed.db, { id: cn.id })).customer).toEqual({ ...oldSnapshot, source: "issued" });
  });
});

describe("preview and issue stay identical; customer_revision binds the approval", () => {
  it("preview sha == issued sha with customer_revision given", async () => {
    const { db, ctx } = await world("snap-preview-sha");
    const args = { ...invoiceArgs, customer_revision: 1 };
    const preview = (await preview_invoice(db, args, ctx)) as any;
    const issued = await create_invoice(db, args, ctx);
    expect(issued.archive_sha256).toBe(preview.sha256);
  });

  it("the issued sha does not depend on passing customer_revision", async () => {
    const a = await world("snap-rev-a");
    const b = await world("snap-rev-b");
    const withRev = await create_invoice(a.db, { ...invoiceArgs, customer_revision: 1 }, a.ctx);
    const without = await create_invoice(b.db, invoiceArgs, b.ctx);
    expect(withRev.archive_sha256).toBe(without.archive_sha256);
  });

  it("a stale customer_revision is refused naming both revisions — preview and issue, nothing issued", async () => {
    const { db, ctx } = await world("snap-rev-stale");
    await changeCustomerTaxData(db, OLD.id, NEW);
    const args = { ...invoiceArgs, customer_revision: 1 };
    const msg = `Customer ${OLD.id} is at revision 2; this request is for revision 1.`;
    await expect(preview_invoice(db, args, ctx)).rejects.toThrow(msg);
    await expect(create_invoice(db, args, ctx)).rejects.toThrow(msg);
    expect(await list_invoices(db, {})).toEqual([]);
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM local_numbers")).toEqual({ n: 0 });
  });

  it("an invoice issued after a change snapshots the new data at its revision", async () => {
    const { db, ctx } = await world("snap-new-rev");
    await changeCustomerTaxData(db, OLD.id, NEW);
    const issued = await create_invoice(db, { ...invoiceArgs, customer_revision: 2 }, ctx);
    expect(issued.customer).toEqual({ ...NEW, revision: 2, source: "issued" });
  });
});
