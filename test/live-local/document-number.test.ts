/**
 * Document numbers name the archived PDF (archive.ts), so every request-
 * supplied number — invoice, credit note, quote — must be a plain file name
 * (document-number.ts), checked before any number is reserved or any file is
 * written. erp-mcp ≤ 0.9.5 only trimmed invoice / credit-note numbers: a
 * number like `../x` wrote the PDF outside the year directory. Defence in
 * depth: the resolved archive path must stay inside the archive directory.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice, preview_invoice, create_credit_note } from "../../src/live/local/tools/invoices.js";
import { create_quote } from "../../src/live/local/tools/quotes.js";
import { archivePath, quoteArchivePath, archiveDir, requireInsideArchive } from "../../src/live/local/archive.js";
import { isSafeDocumentNumber } from "../../src/live/local/document-number.js";
import { freshLocalCtx, cleanupDataDir, seedAtCustomer, INVOICE_ARGS_BASE, TODAY } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const BAD = ["../x", "../../x", "a/b", "/etc/x", "/tmp/x", "..", "a..b", "x\\y", " F-1", "F-1 ", "F 1", "-F1", "F1.", "x".repeat(65), ""];
const LINES = [{ description: "Beratung", qty: 1, unit_price: 100, vat_rate: 20 }];

function invoiceArgs(customer_id: string, number: unknown) {
  return { customer_id, number, ...INVOICE_ARGS_BASE, lines: LINES, net_total: 100 };
}

/** Every file under dataDir except the SQLite DB files. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : name.startsWith("erp-local.sqlite") ? [] : [p];
  });
}

async function count(table: string) {
  return (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
}

describe("the format rule", () => {
  it.each(BAD)("refuses %j", (n) => expect(isSafeDocumentNumber(n)).toBe(false));
  it.each(["F-2026-001", "2026-0001", "SUV-A-2026.01_b", "A", "x".repeat(64)])("accepts %j", (n) =>
    expect(isSafeDocumentNumber(n)).toBe(true)
  );
});

describe("invoice / credit note / quote numbers: refused before any reservation or archive write", () => {
  it.each(BAD.filter((b) => b !== ""))("create_invoice refuses %j — nothing issued, no number used, no file written", async (bad) => {
    ({ db, ctx, dataDir } = await freshLocalCtx("num-inv"));
    const cust = (await seedAtCustomer(db)).id;
    // Without the fix, "../x" etc. issue and write the PDF outside the year directory.
    await expect(create_invoice(db, invoiceArgs(cust, bad), ctx)).rejects.toThrow(/invoice number .* is malformed.*Nothing was issued/);
    await expect(preview_invoice(db, invoiceArgs(cust, bad), ctx)).rejects.toThrow(/malformed/);
    expect(await count("local_numbers")).toBe(0);
    expect(await count("local_invoices")).toBe(0);
    expect(filesUnder(dataDir)).toEqual([]);
  });

  it.each(["../x", "a/b", "/tmp/x", "a..b"])("create_credit_note refuses %j — the invoice stays as it was", async (bad) => {
    ({ db, ctx, dataDir } = await freshLocalCtx("num-cn"));
    const cust = (await seedAtCustomer(db)).id;
    await create_invoice(db, invoiceArgs(cust, "F-2026-001"), ctx);
    const files = filesUnder(dataDir);
    await expect(
      create_credit_note(db, { invoice_id: "F-2026-001", number: bad, document_date: TODAY, credit_total: 100, currency: "EUR", reason: "Storno" }, ctx)
    ).rejects.toThrow(/credit note number .* is malformed/);
    expect(await count("local_numbers")).toBe(1);
    expect(await count("local_credit_notes")).toBe(0);
    expect(filesUnder(dataDir)).toEqual(files);
  });

  it.each(["../x", "a/b", "/tmp/x", "a..b"])("create_quote refuses %j", async (bad) => {
    ({ db, ctx, dataDir } = await freshLocalCtx("num-q"));
    const cust = (await seedAtCustomer(db)).id;
    await expect(
      create_quote(db, { customer_id: cust, number: bad, document_date: TODAY, lines: LINES, value: 100, discount_pct: 0, currency: "EUR" }, ctx)
    ).rejects.toThrow(/quote number .* is malformed/);
    expect(await count("local_quote_numbers")).toBe(0);
    expect(filesUnder(dataDir)).toEqual([]);
  });

  it("well-formed numbers still issue all three kinds", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("num-ok"));
    const cust = (await seedAtCustomer(db)).id;
    await create_invoice(db, invoiceArgs(cust, "F-2026.001_a"), ctx);
    await create_credit_note(db, { invoice_id: "F-2026.001_a", number: "G-2026-001", document_date: TODAY, credit_total: 100, currency: "EUR", reason: "Storno" }, ctx);
    await create_quote(db, { customer_id: cust, number: "A-2026-001", document_date: TODAY, lines: LINES, value: 100, discount_pct: 0, currency: "EUR" }, ctx);
    for (const f of filesUnder(dataDir)) expect(f.startsWith(archiveDir(dataDir))).toBe(true);
    expect(filesUnder(dataDir)).toHaveLength(3);
  });
});

describe("defence in depth: the resolved archive path stays inside the archive directory", () => {
  const root = "/data/suveren";
  it("archivePath (invoices, credit notes) refuses traversal and absolute numbers", () => {
    expect(archivePath(root, 2026, "F-1")).toBe("/data/suveren/erp-local-archive/2026/F-1.pdf");
    for (const n of ["../../x", "../../../etc/passwd", "/../../../tmp/x"]) {
      expect(() => archivePath(root, 2026, n)).toThrow(/outside the archive directory/);
    }
  });

  it("quoteArchivePath refuses traversal", () => {
    expect(quoteArchivePath(root, 2026, "A-1", 2)).toBe("/data/suveren/erp-local-archive/quotes/2026/A-1-r2.pdf");
    expect(() => quoteArchivePath(root, 2026, "../../../x", 1)).toThrow(/outside the archive directory/);
  });

  it("requireInsideArchive refuses the directory itself, a sibling and an absolute elsewhere", () => {
    expect(() => requireInsideArchive(root, archiveDir(root))).toThrow(/outside/);
    expect(() => requireInsideArchive(root, "/data/suveren/erp-local-archive-evil/x.pdf")).toThrow(/outside/);
    expect(() => requireInsideArchive(root, "/tmp/x.pdf")).toThrow(/outside/);
    expect(requireInsideArchive(root, "/data/suveren/erp-local-archive/2026/x.pdf")).toBe("/data/suveren/erp-local-archive/2026/x.pdf");
  });
});
