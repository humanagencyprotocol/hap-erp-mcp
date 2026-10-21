/**
 * Quote → invoice (docs/local-production-contract.md §4.4, AM2, R7, R8, D1):
 * create_invoice / preview_invoice with quote_id + quote_revision. The normal
 * invoice path still applies (number + today's date, tax mode from the
 * customer's current data, VAT vs tax mode, D1); AM2 refuses when the
 * customer changed since the quote revision was made; the quote is marked
 * converted in the same transaction as the invoice insert.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice, preview_invoice, get_invoice } from "../../src/live/local/tools/invoices.js";
import { create_quote, update_quote, get_quote } from "../../src/live/local/tools/quotes.js";
import {
  freshLocalCtx, cleanupDataDir, seedAtCustomer, seedDeCustomer, changeCustomerTaxData,
  MUSTER_COMPANY_KLEINUNTERNEHMER, INVOICE_ARGS_BASE, TODAY, markViesValid,
} from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const LINES = [
  { description: "Beratung", qty: 10, unit: "Std.", unit_price: 120, vat_rate: 20 },
  { description: "Workshop", qty: 1, unit_price: 900, vat_rate: 20 },
];
const ZERO_VAT = LINES.map((l) => ({ ...l, vat_rate: 0 }));

async function worldWithQuote(label: string, opts: { de?: boolean } = {}) {
  ({ db, ctx, dataDir } = await freshLocalCtx(label));
  const cust = opts.de ? await seedDeCustomer(db) : await seedAtCustomer(db);
  const quote = await create_quote(db, {
    customer_id: cust.id, number: "SUV-A-2026-010", document_date: TODAY, lines: opts.de ? ZERO_VAT : LINES,
    value: 2100, discount_pct: 0, currency: "EUR",
  }, ctx);
  return { cust: cust.id, quote };
}

function convertArgs(cust: string, quoteId: string, over: Record<string, unknown> = {}) {
  return { customer_id: cust, quote_id: quoteId, quote_revision: 1, number: "2026-0700", ...INVOICE_ARGS_BASE, net_total: 2100, ...over };
}

async function n(table: string): Promise<number> {
  return (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
}

async function expectNothingIssued(quoteId: string) {
  expect(await n("local_invoices")).toBe(0);
  expect(await n("local_numbers")).toBe(0);
  expect((await get_quote(db, { id: quoteId })).status).toBe("issued");
}

describe("conversion", () => {
  it("copies the quote revision's lines when omitted; quote converted and invoice linked", async () => {
    const { cust, quote } = await worldWithQuote("conv-copy");
    const inv = await create_invoice(db, { ...convertArgs(cust, quote.id), ticket_id: "t-inv" }, ctx);
    expect(inv).toMatchObject({ number: "2026-0700", quote_id: quote.id, quote_revision: 1, net_total: 2100, vat_total: 420 });
    expect(inv.lines.map((l: any) => [l.description, l.qty, l.unit, l.unit_price, l.vat_rate])).toEqual([
      ["Beratung", 10, "Std.", 120, 20], ["Workshop", 1, "Stk.", 900, 20],
    ]);
    const after = await get_quote(db, { id: quote.id });
    expect(after).toMatchObject({ status: "converted", invoice_id: inv.id, revision: 1 });
  });

  it("accepts the quote number as quote_id and explicit lines (partial invoicing)", async () => {
    const { cust, quote } = await worldWithQuote("conv-partial");
    const inv = await create_invoice(db, convertArgs(cust, quote.number, { lines: [LINES[1]], net_total: 900 }), ctx);
    expect(inv).toMatchObject({ net_total: 900, quote_id: quote.id });
  });

  it("preview_invoice with the quote renders exactly what create_invoice issues", async () => {
    const { cust, quote } = await worldWithQuote("conv-preview");
    const preview = await preview_invoice(db, convertArgs(cust, quote.id), ctx);
    expect(await n("local_invoices")).toBe(0);
    const inv = await create_invoice(db, convertArgs(cust, quote.id), ctx);
    expect(inv.archive_sha256).toBe(preview.sha256);
  });

  it("a second conversion is refused naming the invoice", async () => {
    const { cust, quote } = await worldWithQuote("conv-twice");
    await create_invoice(db, convertArgs(cust, quote.id), ctx);
    await expect(create_invoice(db, convertArgs(cust, quote.id, { number: "2026-0701" }), ctx)).rejects.toThrow(
      /quote SUV-A-2026-010 was already invoiced \(invoice 2026-0700\)/
    );
    expect(await n("local_invoices")).toBe(1);
  });

  it("a stale quote_revision is refused naming both revisions; nothing issued", async () => {
    const { cust, quote } = await worldWithQuote("conv-stale");
    await update_quote(db, { id: quote.id, revision: 1, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR", notes: "r2" }, ctx);
    await expect(create_invoice(db, convertArgs(cust, quote.id), ctx)).rejects.toThrow(
      "Quote SUV-A-2026-010 is at revision 2; this request is for revision 1."
    );
    await expectNothingIssued(quote.id);
    await create_invoice(db, convertArgs(cust, quote.id, { quote_revision: 2 }), ctx);
  });

  it("quote_id without quote_revision (and vice versa) and a different customer are refused", async () => {
    const { cust, quote } = await worldWithQuote("conv-shape");
    await expect(create_invoice(db, convertArgs(cust, quote.id, { quote_revision: undefined }), ctx)).rejects.toThrow(/go together/);
    await expect(create_invoice(db, convertArgs(cust, undefined as any), ctx)).rejects.toThrow(/go together/);
    const other = await seedDeCustomer(db);
    await expect(create_invoice(db, convertArgs(other.id, quote.id), ctx)).rejects.toThrow(/customer_id mismatch/);
    await expectNothingIssued(quote.id);
  });

  it("R7: the invoice number and today's date are still required", async () => {
    const { cust, quote } = await worldWithQuote("conv-r7");
    await expect(create_invoice(db, convertArgs(cust, quote.id, { number: undefined }), ctx)).rejects.toThrow(/number is required/);
    const yesterday = new Date(Date.parse(TODAY) - 86400000).toISOString().slice(0, 10);
    await expect(create_invoice(db, convertArgs(cust, quote.id, { document_date: yesterday }), ctx)).rejects.toThrow(
      new RegExp(`document_date is dated ${yesterday}`)
    );
    await expect(create_invoice(db, convertArgs(cust, quote.id, { net_total: 1 }), ctx)).rejects.toThrow(/net_total mismatch/);
    await expectNothingIssued(quote.id);
  });
});

describe("AM2: conversion refuses a customer changed since the quote revision", () => {
  it("refused naming both customer revisions; works again once the quote is updated", async () => {
    const { cust, quote } = await worldWithQuote("conv-am2");
    await changeCustomerTaxData(db, cust, { name: "Drautal AG", address_lines: ["Neu 1", "9500 Villach"], country: "AT", uid: "ATU87654321" }, ctx);
    for (const call of [create_invoice, preview_invoice]) {
      await expect(call(db, convertArgs(cust, quote.id), ctx)).rejects.toThrow(
        `Customer ${cust} is at revision 2; quote SUV-A-2026-010 revision 1 was made for customer revision 1 — update the quote first.`
      );
    }
    await expectNothingIssued(quote.id);
    const q2 = await update_quote(db, { id: quote.id, revision: 1, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR" }, ctx);
    expect(q2.customer.revision).toBe(2);
    const inv = await create_invoice(db, convertArgs(cust, quote.id, { quote_revision: 2 }), ctx);
    expect(inv.customer).toMatchObject({ name: "Drautal AG", revision: 2 });
  });

  it("a normal-VAT quote does not turn into a reverse-charge invoice after a VAT-ID change", async () => {
    const { cust, quote } = await worldWithQuote("conv-am2-rc");
    await changeCustomerTaxData(db, cust, {
      name: "Drautal GmbH", address_lines: ["Hafenstraße 4", "20457 Hamburg"], country: "DE", uid: "DE123456789",
    }, ctx);
    await expect(create_invoice(db, convertArgs(cust, quote.id), ctx)).rejects.toThrow(/is at revision 2; quote .* customer revision 1/);
    await expectNothingIssued(quote.id);
  });
});

describe("R8: VAT vs tax mode on conversion", () => {
  it("explicit 20 % lines for a reverse-charge customer are refused, nothing issued", async () => {
    const { cust, quote } = await worldWithQuote("conv-r8-lines", { de: true });
    await expect(create_invoice(db, convertArgs(cust, quote.id, { lines: LINES }), ctx)).rejects.toThrow(
      /invoice lines must have vat_rate 0 — .*reverse charge/
    );
    await expectNothingIssued(quote.id);
    const ok = await create_invoice(db, convertArgs(cust, quote.id), ctx);
    expect(ok).toMatchObject({ tax_mode: "reverse_charge", vat_total: 0 });
  });

  it("the quote's 20 % lines are refused when the company has become a Kleinunternehmer", async () => {
    const { cust, quote } = await worldWithQuote("conv-r8-ku");
    const kuCtx = { ...ctx, company: MUSTER_COMPANY_KLEINUNTERNEHMER };
    await expect(create_invoice(db, convertArgs(cust, quote.id), kuCtx)).rejects.toThrow(/vat_rate 0 — .*Kleinunternehmer/);
    await expectNothingIssued(quote.id);
  });
});

describe("D1: reverse charge on conversion needs the customer's stored VIES `valid`", () => {
  it("refused while VIES is not `valid`; issued once it is", async () => {
    const { cust, quote } = await worldWithQuote("conv-d1", { de: true });
    await db.run("UPDATE local_customers SET vies_status = 'not_checked' WHERE id = ?", [cust]);
    await expect(create_invoice(db, convertArgs(cust, quote.id), ctx)).rejects.toThrow(/confirm the VAT ID first/);
    await expectNothingIssued(quote.id);
    await markViesValid(db, cust);
    const inv = await create_invoice(db, convertArgs(cust, quote.id), ctx);
    expect(inv.tax_mode).toBe("reverse_charge");
  });
});

describe("one transaction", () => {
  it("if marking the quote converted fails, no invoice exists and no number is consumed", async () => {
    const { cust, quote } = await worldWithQuote("conv-tx");
    await db.run(
      `CREATE TRIGGER fail_convert BEFORE UPDATE OF status ON local_quotes BEGIN SELECT RAISE(ABORT, 'boom'); END`
    );
    await expect(create_invoice(db, convertArgs(cust, quote.id), ctx)).rejects.toThrow(/boom/);
    await expectNothingIssued(quote.id);
    expect(await get_invoice(db, { id: "2026-0700" }).catch((e) => e)).toBeInstanceOf(Error);
  });
});
