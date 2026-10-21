/**
 * R6 — deterministic quote PDFs (docs/local-production-contract.md §4.3,
 * §4.5): preview_quote renders through the same pdfmake path as invoices with
 * the creation date fixed to document_date, so a preview's sha256 equals the
 * archived sha256 of the quote issued with the same arguments; get_document
 * kind "quote-pdf" returns the archived bytes, sha-verified.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, readFileSync } from "fs";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { get_document } from "../../src/live/local/tools/invoices.js";
import { create_quote, update_quote, preview_quote } from "../../src/live/local/tools/quotes.js";
import { loadTemplateFile, DEFAULT_QUOTE_TEMPLATE_PATH, resolveQuoteTemplate } from "../../src/live/local/template.js";
import { sha256 } from "../../src/live/local/archive.js";
import { freshLocalCtx, cleanupDataDir, seedAtCustomer, DEFAULT_TEMPLATE, TODAY } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const LINES = [{ description: "Beratung", qty: 10, unit: "Std.", unit_price: 120, vat_rate: 20 }];
const args = (customer_id: string) => ({
  customer_id, number: "SUV-A-2026-007", document_date: TODAY, lines: LINES, value: 1200, discount_pct: 0, currency: "EUR",
  valid_until: "2099-12-31",
});

describe("R6: preview sha == archived sha", () => {
  it("for create_quote — even when issuing happens later than the preview", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("qpdf-create"));
    const cust = (await seedAtCustomer(db)).id;
    const preview = await preview_quote(db, args(cust), ctx);
    expect(preview).toMatchObject({ filename: "SUV-A-2026-007-r1.pdf", contentType: "application/pdf", pages: 1 });
    // A render that read "now" (seconds resolution in the PDF info dict) would differ after this wait.
    await new Promise((r) => setTimeout(r, 1100));
    const issued = await create_quote(db, args(cust), ctx);
    expect(issued.document!.sha256).toBe(preview.sha256);
    const doc = await get_document(db, { kind: "quote-pdf", id: "SUV-A-2026-007" });
    expect(doc.sha256).toBe(preview.sha256);
    expect(doc.contentBase64).toBe(preview.contentBase64);
    expect(doc.filename).toBe("SUV-A-2026-007-r1.pdf");
  });

  it("for update_quote (preview with id renders the next revision)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("qpdf-update"));
    const cust = (await seedAtCustomer(db)).id;
    const q = await create_quote(db, args(cust), ctx);
    const upd = { id: q.id, revision: 1, document_date: TODAY, lines: [{ ...LINES[0], qty: 12 }], value: 1440, discount_pct: 0, currency: "EUR" };
    const preview = await preview_quote(db, upd, ctx);
    expect(preview.filename).toBe("SUV-A-2026-007-r2.pdf");
    const issued = await update_quote(db, upd, ctx);
    expect(issued.document!.sha256).toBe(preview.sha256);
    expect((await get_document(db, { kind: "quote-pdf", id: q.id })).sha256).toBe(preview.sha256);
  });

  it("two renders of the same arguments are byte-identical; a preview reserves and archives nothing", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("qpdf-twice"));
    const cust = (await seedAtCustomer(db)).id;
    const a = await preview_quote(db, { ...args(cust), document_date: "2026-01-15" }, ctx);
    const b = await preview_quote(db, { ...args(cust), document_date: "2026-01-15" }, ctx);
    expect(a.contentBase64).toBe(b.contentBase64);
    expect(sha256(Buffer.from(a.contentBase64, "base64"))).toBe(a.sha256);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM local_quote_numbers"))!.n).toBe(0);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM local_quotes"))!.n).toBe(0);
  });
});

describe("quote template", () => {
  it("the bundled default is angebot-de v1 and declares only the quote document", () => {
    const t = loadTemplateFile(DEFAULT_QUOTE_TEMPLATE_PATH);
    expect(t).toMatchObject({ template: "angebot-de", version: "1", documents: ["quote"] });
    expect(resolveQuoteTemplate({}).path).toBe(DEFAULT_QUOTE_TEMPLATE_PATH);
  });

  it("a template without `quote` in documents is refused — nothing issued", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("qpdf-template"));
    const cust = (await seedAtCustomer(db)).id;
    const qctx = { ...ctx, quoteTemplate: DEFAULT_TEMPLATE }; // the invoice template: invoice + credit_note only
    await expect(create_quote(db, args(cust), qctx)).rejects.toThrow(/does not support document kind "quote"/);
    await expect(preview_quote(db, args(cust), qctx)).rejects.toThrow(/does not support document kind "quote"/);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM local_quotes"))!.n).toBe(0);
  });
});

describe("get_document kind quote-pdf", () => {
  it("refuses a tampered archive and an unknown quote", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("qpdf-tamper"));
    const cust = (await seedAtCustomer(db)).id;
    await create_quote(db, args(cust), ctx);
    const row = await db.get<{ archive_path: string }>("SELECT archive_path FROM local_quotes");
    expect(row!.archive_path).toContain("/erp-local-archive/quotes/");
    writeFileSync(row!.archive_path, Buffer.concat([readFileSync(row!.archive_path), Buffer.from("x")]));
    await expect(get_document(db, { kind: "quote-pdf", id: "SUV-A-2026-007" })).rejects.toThrow(/does not match its stored fingerprint/);
    await expect(get_document(db, { kind: "quote-pdf", id: "nope" })).rejects.toThrow(/Unknown quote/);
  });
});
