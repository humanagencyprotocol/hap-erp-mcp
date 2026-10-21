/**
 * Part B — quotes in ERP Local (docs/local-production-contract.md §4 with
 * Andreas's decisions §12 D2/D3): numbers come with the request in their own
 * series, the PDF is issued at create/update (no send step), the revision
 * rule, and "nothing on refusal".
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice } from "../../src/live/local/tools/invoices.js";
import { create_quote, update_quote, get_quote, list_quotes } from "../../src/live/local/tools/quotes.js";
import { create_item } from "../../src/live/local/tools/items.js";
import {
  freshLocalCtx, cleanupDataDir, seedAtCustomer, seedDeCustomer, changeCustomerTaxData, INVOICE_ARGS_BASE, TODAY,
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

function quoteArgs(customerId: string, over: Record<string, unknown> = {}) {
  return {
    customer_id: customerId, number: "SUV-A-2026-001", document_date: TODAY, lines: LINES,
    value: 2100, discount_pct: 0, currency: "EUR", valid_until: "2099-12-31", ...over,
  };
}

async function world(label: string) {
  ({ db, ctx, dataDir } = await freshLocalCtx(label));
  return (await seedAtCustomer(db)).id;
}

async function count(table: string): Promise<number> {
  return (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
}

function archivedQuoteFiles(): string[] {
  const dir = join(dataDir, "erp-local-archive", "quotes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((y) => readdirSync(join(dir, y)));
}

async function expectNothingSaved() {
  expect(await count("local_quotes")).toBe(0);
  expect(await count("local_quote_numbers")).toBe(0);
  expect(await count("local_quote_revisions")).toBe(0);
  expect(await count("local_quote_lines")).toBe(0);
  expect(archivedQuoteFiles()).toEqual([]);
}

describe("create_quote — D2: the number comes with the request, own series", () => {
  it("issues revision 1 under the requested number with the PDF archived; status issued", async () => {
    const cust = await world("q-create");
    const q = await create_quote(db, { ...quoteArgs(cust), ticket_id: "t-q1" }, ctx);
    // Fails if the connector assigned its own number (the pre-D2 contract's Q-YYYY-NNNN).
    expect(q.number).toBe("SUV-A-2026-001");
    expect(q).toMatchObject({ status: "issued", revision: 1, net_total: 2100, discount_pct: 0, currency: "EUR", ticket_id: "t-q1" });
    expect(q.document).toMatchObject({ filename: "SUV-A-2026-001-r1.pdf", document_date: TODAY, template: "angebot-de v1" });
    expect(q.document!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(q.customer).toMatchObject({ name: "Drautal Maschinenbau GmbH", uid: "ATU12345678", revision: 1, source: "issued" });
    expect(q.lines.map((l) => l.line_net)).toEqual([1200, 900]);
    expect(archivedQuoteFiles()).toEqual(["SUV-A-2026-001-r1.pdf"]);
    const row = await db.get<any>("SELECT * FROM local_quote_numbers");
    expect(row).toMatchObject({ number: "SUV-A-2026-001", year: Number(TODAY.slice(0, 4)), seq: 1, quote_id: q.id });
  });

  it("refuses a missing number — never assigns one; nothing saved", async () => {
    const cust = await world("q-no-number");
    const { number: _n, ...noNumber } = quoteArgs(cust);
    await expect(create_quote(db, noNumber, ctx)).rejects.toThrow(/number is required.*never assigns one.*Nothing was issued/);
    await expectNothingSaved();
  });

  it.each([" SUV-1", "SUV 1", "../SUV-1", "a/b", "-SUV", "SUV-", "x".repeat(65), 17])(
    "refuses the malformed number %j; nothing saved",
    async (bad) => {
      const cust = await world("q-malformed");
      await expect(create_quote(db, quoteArgs(cust, { number: bad }), ctx)).rejects.toThrow(/malformed/);
      await expectNothingSaved();
    }
  );

  it("refuses a number already used by a quote (also differing only in case); the first stays", async () => {
    const cust = await world("q-dup");
    await create_quote(db, quoteArgs(cust), ctx);
    await expect(create_quote(db, quoteArgs(cust), ctx)).rejects.toThrow(/already been used \(quote SUV-A-2026-001\)/);
    await expect(create_quote(db, quoteArgs(cust, { number: "suv-a-2026-001" }), ctx)).rejects.toThrow(/already been used/);
    expect(await count("local_quotes")).toBe(1);
  });

  it("R7: never collides with or consumes an invoice number", async () => {
    const cust = await world("q-vs-invoice");
    await create_invoice(db, {
      customer_id: cust, number: "2026-0001", ...INVOICE_ARGS_BASE,
      lines: [{ description: "x", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100,
    }, ctx);
    await expect(create_quote(db, quoteArgs(cust, { number: "2026-0001" }), ctx)).rejects.toThrow(
      /already the number of an invoice \(2026-0001\) — quotes have their own series/
    );
    const before = await db.all("SELECT * FROM local_numbers");
    await create_quote(db, quoteArgs(cust, { number: "A-2026-0002" }), ctx);
    expect(await db.all("SELECT * FROM local_numbers")).toEqual(before);
    // …and the series never collide the other way either (review finding 4): an
    // invoice may not take a quote's number, in any case.
    for (const number of ["A-2026-0002", "a-2026-0002"]) {
      await expect(create_invoice(db, {
        customer_id: cust, number, ...INVOICE_ARGS_BASE,
        lines: [{ description: "x", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100,
      }, ctx)).rejects.toThrow(/already the number of a quote \(A-2026-0002\) — invoices and credit notes have their own series/);
    }
    expect(await db.all("SELECT * FROM local_numbers")).toEqual(before);
  });

  it("document_date as invoices: not today → refused, nothing saved", async () => {
    const cust = await world("q-date");
    await expect(create_quote(db, quoteArgs(cust, { document_date: "2020-01-01" }), ctx)).rejects.toThrow(
      /document_date is dated 2020-01-01, today is .*Nothing was issued/
    );
    await expect(create_quote(db, quoteArgs(cust, { document_date: "yesterday" }), ctx)).rejects.toThrow();
    await expectNothingSaved();
  });

  it("refuses discount_pct ≠ 0, a wrong value, a non-EUR currency, valid_until before the date — nothing saved", async () => {
    const cust = await world("q-declared");
    await expect(create_quote(db, quoteArgs(cust, { discount_pct: 5 }), ctx)).rejects.toThrow(/discount_pct mismatch.*Local quotes price each line/);
    await expect(create_quote(db, quoteArgs(cust, { value: 2000 }), ctx)).rejects.toThrow(/value mismatch — declared 2000, expected 2100/);
    await expect(create_quote(db, quoteArgs(cust, { currency: "USD" }), ctx)).rejects.toThrow(/currency mismatch/);
    await expect(create_quote(db, quoteArgs(cust, { valid_until: "2000-01-01" }), ctx)).rejects.toThrow(/valid_until .* before/);
    await expectNothingSaved();
  });

  it("refuses line VAT that contradicts the customer's tax mode (reverse charge) — nothing saved", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("q-rc-vat"));
    const de = await seedDeCustomer(db);
    await expect(create_quote(db, quoteArgs(de.id), ctx)).rejects.toThrow(/quote lines must have vat_rate 0 — .*reverse charge/);
    await expectNothingSaved();
    const ok = await create_quote(db, quoteArgs(de.id, { lines: LINES.map((l) => ({ ...l, vat_rate: 0 })) }), ctx);
    expect(ok.status).toBe("issued");
  });

  it("lines with item_id store the item's list price and revision; an unknown item is refused", async () => {
    const cust = await world("q-items");
    const item = await create_item(db, { name: "Beratung", kind: "service", unit: "Std.", list_price: 130, vat_rate: 20 });
    const q = await create_quote(db, quoteArgs(cust, { lines: [{ ...LINES[0], item_id: item.id }, LINES[1]] }), ctx);
    expect(q.lines[0]).toMatchObject({ item_id: item.id, list_price: 130, item_revision: 1, unit_price: 120 });
    expect(q.lines[1]).toMatchObject({ item_id: null, list_price: null });
    await expect(
      create_quote(db, quoteArgs(cust, { number: "X-2", lines: [{ ...LINES[0], item_id: "nope" }] }), ctx)
    ).rejects.toThrow();
  });
});

describe("update_quote — revision rule, own PDF per revision", () => {
  it("produces revision 2 with its own archived PDF; revision 1 stays readable", async () => {
    const cust = await world("q-update");
    const q1 = await create_quote(db, quoteArgs(cust), ctx);
    const q2 = await update_quote(db, {
      id: q1.id, revision: 1, document_date: TODAY, lines: [LINES[0]], value: 1200, discount_pct: 0, currency: "EUR", ticket_id: "t-q2",
    }, ctx);
    expect(q2).toMatchObject({ number: q1.number, revision: 2, net_total: 1200, valid_until: "2099-12-31", ticket_id: "t-q2" });
    expect(q2.document!.filename).toBe("SUV-A-2026-001-r2.pdf");
    expect(q2.document!.sha256).not.toBe(q1.document!.sha256);
    expect(archivedQuoteFiles().sort()).toEqual(["SUV-A-2026-001-r1.pdf", "SUV-A-2026-001-r2.pdf"]);
    const old = await get_quote(db, { id: q1.number, revision: 1 });
    expect(old).toMatchObject({ revision: 1, net_total: 2100, document: null });
    expect(old.lines).toHaveLength(2);
  });

  it("keeps the lines when omitted; any successful update is a new revision", async () => {
    const cust = await world("q-update-keep");
    const q1 = await create_quote(db, quoteArgs(cust), ctx);
    const q2 = await update_quote(db, { id: q1.id, revision: 1, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR", notes: "n" }, ctx);
    expect(q2).toMatchObject({ revision: 2, notes: "n" });
    expect(q2.lines).toEqual(q1.lines);
  });

  it("finding 5: revision is required — an update that names none is refused, nothing written", async () => {
    const cust = await world("q-norev");
    const q1 = await create_quote(db, quoteArgs(cust), ctx);
    await expect(
      update_quote(db, { id: q1.id, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR", notes: "n" }, ctx)
    ).rejects.toThrow(/revision is required/);
    expect(archivedQuoteFiles()).toEqual(["SUV-A-2026-001-r1.pdf"]);
    expect(await count("local_quote_revisions")).toBe(1);
  });

  it("stale revision is refused naming both; nothing changes", async () => {
    const cust = await world("q-stale");
    const q1 = await create_quote(db, quoteArgs(cust), ctx);
    await update_quote(db, { id: q1.id, revision: 1, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR" }, ctx);
    await expect(
      update_quote(db, { id: q1.id, revision: 1, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR" }, ctx)
    ).rejects.toThrow("Quote SUV-A-2026-001 is at revision 2; this request is for revision 1.");
    expect((await get_quote(db, { id: q1.id })).revision).toBe(2);
    expect(await count("local_quote_revisions")).toBe(2);
  });

  it("refuses document_date ≠ today and a value mismatch, writing nothing", async () => {
    const cust = await world("q-update-refuse");
    const q1 = await create_quote(db, quoteArgs(cust), ctx);
    await expect(update_quote(db, { id: q1.id, revision: 1, document_date: "2020-01-01", value: 2100, discount_pct: 0, currency: "EUR" }, ctx)).rejects.toThrow(/today/);
    await expect(update_quote(db, { id: q1.id, revision: 1, document_date: TODAY, value: 1, discount_pct: 0, currency: "EUR" }, ctx)).rejects.toThrow(/value mismatch/);
    expect(archivedQuoteFiles()).toEqual(["SUV-A-2026-001-r1.pdf"]);
    expect(await count("local_quote_revisions")).toBe(1);
  });

  it("takes the customer's current data into the new revision's snapshot", async () => {
    const cust = await world("q-update-customer");
    const q1 = await create_quote(db, quoteArgs(cust), ctx);
    await changeCustomerTaxData(db, cust, { name: "Drautal AG", address_lines: ["Neu 1", "9500 Villach"], country: "AT", uid: "ATU87654321" });
    const q2 = await update_quote(db, { id: q1.id, revision: 1, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR" }, ctx);
    expect(q2.customer).toMatchObject({ name: "Drautal AG", uid: "ATU87654321", revision: 2 });
    expect((await get_quote(db, { id: q1.id, revision: 1 })).customer).toMatchObject({ name: "Drautal Maschinenbau GmbH", revision: 1 });
  });

  it("a converted quote never changes", async () => {
    const cust = await world("q-update-converted");
    const q = await create_quote(db, quoteArgs(cust), ctx);
    await create_invoice(db, { customer_id: cust, quote_id: q.id, quote_revision: 1, number: "2026-0500", ...INVOICE_ARGS_BASE, net_total: 2100 }, ctx);
    await expect(
      update_quote(db, { id: q.id, revision: 1, document_date: TODAY, value: 2100, discount_pct: 0, currency: "EUR" }, ctx)
    ).rejects.toThrow(/was converted to invoice 2026-0500 — a converted quote never changes/);
  });
});

describe("list_quotes / get_quote", () => {
  it("filters by status and customer; get_quote accepts the number", async () => {
    const cust = await world("q-list");
    const a = await create_quote(db, quoteArgs(cust, { number: "Q-A" }), ctx);
    await create_quote(db, quoteArgs(cust, { number: "Q-B" }), ctx);
    await create_invoice(db, { customer_id: cust, quote_id: a.id, quote_revision: 1, number: "2026-0600", ...INVOICE_ARGS_BASE, net_total: 2100 }, ctx);
    expect((await list_quotes(db, { status: "issued" })).map((q) => q.number)).toEqual(["Q-B"]);
    expect((await list_quotes(db, { status: "converted" })).map((q) => q.number)).toEqual(["Q-A"]);
    expect(await list_quotes(db, { customer_id: "other" })).toEqual([]);
    const got = await get_quote(db, { id: "Q-A" });
    expect(got).toMatchObject({ status: "converted", invoice_id: expect.any(String) });
    await expect(get_quote(db, { id: "nope" })).rejects.toThrow(/Unknown quote/);
  });
});
