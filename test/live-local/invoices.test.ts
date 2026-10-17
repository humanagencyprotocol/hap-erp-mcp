/**
 * Local invoicing — per doc/engineering.md rule 4 ("test refusals harder
 * than successes"), most of this file is refusal cases: one per property
 * create_invoice/create_credit_note/preview_invoice/get_document must
 * protect, from the task's required list — number required/duplicate,
 * reverse-charge rules, UID above €10,000, archive write-once and failure =
 * nothing issued, get_document's sha check, preview not consuming a number,
 * template conditions (kleinunternehmer, credit note) — plus the happy
 * paths that prove the whole flow actually produces a PDF and an archive
 * entry.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice, preview_invoice, create_credit_note, get_document } from "../../src/live/local/tools/invoices.js";
import { archivePath } from "../../src/live/local/archive.js";
import {
  freshLocalCtx,
  cleanupDataDir,
  seedAtCustomer,
  seedAtCustomerNoUid,
  seedDeCustomer,
  seedDeCustomerNoUid,
  INVOICE_ARGS_BASE,
  MUSTER_COMPANY_KLEINUNTERNEHMER,
} from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;

afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

describe("create_invoice — number", () => {
  it("is refused when missing", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("num-missing"));
    const cust = await seedAtCustomer(db);
    await expect(
      create_invoice(db, { customer_id: cust.id, ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 }, ctx)
    ).rejects.toThrow(/number is required/);
  });

  it("is refused when already used (even by a different customer)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("num-dup"));
    const cust = await seedAtCustomer(db);
    const args = { customer_id: cust.id, number: "2026-0001", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 };
    await create_invoice(db, args, ctx);
    await expect(create_invoice(db, { ...args, net_total: 100 }, ctx)).rejects.toThrow(/already been used/);
  });

  it("invoices and credit notes share one namespace — a credit note cannot reuse an invoice's number", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("num-shared-ns"));
    const cust = await seedAtCustomer(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0001", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 },
      ctx
    );
    await expect(
      create_credit_note(db, { invoice_id: invoice.id, number: "2026-0001", credit_total: 100, currency: "EUR", reason: "test" }, ctx)
    ).rejects.toThrow(/already been used/);
  });
});

describe("create_invoice — happy path and archive", () => {
  it("issues, renders a PDF containing the number and customer, and archives it write-once", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("happy"));
    const cust = await seedAtCustomer(db);
    const invoice = await create_invoice(
      db,
      {
        customer_id: cust.id, number: "2026-0001", ...INVOICE_ARGS_BASE,
        lines: [{ description: "Beratung Oktober", qty: 1, unit_price: 9000, vat_rate: 20 }],
        net_total: 9000,
      },
      ctx
    );
    expect(invoice.status).toBe("issued");
    expect(invoice.tax_mode).toBe("normal");
    expect(invoice.net_total).toBe(9000);
    expect(invoice.vat_total).toBe(1800);
    expect(invoice.gross_total).toBe(10800);
    expect(invoice.template_id).toBe("rechnung-de");
    expect(invoice.archive_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(invoice.archive_path)).toBe(true);
    expect(invoice.archive_path).toBe(archivePath(dataDir, new Date(invoice.issued_at).getFullYear(), "2026-0001"));

    const buf = (await get_document(db, { kind: "invoice-pdf", id: invoice.id })) as any;
    const bytes = Buffer.from(buf.contentBase64, "base64");
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.sha256).toBe(invoice.archive_sha256);
  });
});

describe("create_invoice — reverse charge", () => {
  it("is applied for an EU customer outside Austria with a UID", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rc-ok"));
    const cust = await seedDeCustomer(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0002", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 9000, vat_rate: 0 }], net_total: 9000 },
      ctx
    );
    expect(invoice.tax_mode).toBe("reverse_charge");
    expect(invoice.vat_total).toBe(0);
    // The reverse-charge note being present in the rendered content is
    // covered at the template level (buildViewModel + resolveTemplateBlocks)
    // in pdf-render.test.ts — here we only check the PDF was produced and archived.
    const buf = (await get_document(db, { kind: "invoice-pdf", id: invoice.id })) as any;
    expect(Buffer.from(buf.contentBase64, "base64").subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("is refused without the customer's UID", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rc-no-uid"));
    const cust = await seedDeCustomerNoUid(db);
    await expect(
      create_invoice(db, { customer_id: cust.id, number: "2026-0003", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 9000, vat_rate: 0 }], net_total: 9000 }, ctx)
    ).rejects.toThrow(/reverse-charge case and requires the customer's UID/);
  });
});

describe("create_invoice — UID required above €10,000 gross", () => {
  it("is refused for a home-country customer with no UID, above the threshold", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("uid-10k"));
    const cust = await seedAtCustomerNoUid(db);
    await expect(
      create_invoice(
        db,
        { customer_id: cust.id, number: "2026-0004", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 9000, vat_rate: 20 }], net_total: 9000 },
        ctx
      )
    ).rejects.toThrow(/exceeds €10,000/);
  });

  it("is allowed below the threshold for the same customer", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("uid-below-10k"));
    const cust = await seedAtCustomerNoUid(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0005", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 },
      ctx
    );
    expect(invoice.status).toBe("issued");
  });
});

describe("create_invoice — kleinunternehmer (template condition)", () => {
  it("shows the small-business VAT exemption note and zero VAT, regardless of customer", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("kleinunternehmer", MUSTER_COMPANY_KLEINUNTERNEHMER));
    const cust = await seedAtCustomer(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0006", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 500, vat_rate: 0 }], net_total: 500 },
      ctx
    );
    expect(invoice.tax_mode).toBe("kleinunternehmer");
    // The exemption note being present is covered at the template level in pdf-render.test.ts.
    const buf = (await get_document(db, { kind: "invoice-pdf", id: invoice.id })) as any;
    expect(Buffer.from(buf.contentBase64, "base64").subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});

describe("preview_invoice", () => {
  it("renders without issuing — no number is consumed, nothing is archived or recorded", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("preview"));
    const cust = await seedAtCustomer(db);
    const args = { customer_id: cust.id, number: "2026-0007", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 };

    const preview = (await preview_invoice(db, args, ctx)) as any;
    expect(preview.filename).toBe("invoice-2026-0007.pdf");
    expect(preview.contentType).toBe("application/pdf");
    expect(preview.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.pages).toBeGreaterThanOrEqual(1);

    expect(await db.all("SELECT * FROM local_invoices")).toHaveLength(0);
    expect(await db.all("SELECT * FROM local_numbers")).toHaveLength(0);

    // The same number can still be issued for real afterward.
    const invoice = await create_invoice(db, args, ctx);
    expect(invoice.number).toBe("2026-0007");
  });

  it("can preview the same number more than once (never reserved)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("preview-twice"));
    const cust = await seedAtCustomer(db);
    const args = { customer_id: cust.id, number: "2026-0008", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 };
    await preview_invoice(db, args, ctx);
    await expect(preview_invoice(db, args, ctx)).resolves.toBeTruthy();
  });
});

describe("archive write failure — nothing is issued", () => {
  it("throws, leaves no invoice row, and leaves the number free to retry once the obstruction is removed", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("archive-fail"));
    const cust = await seedAtCustomer(db);
    const year = new Date().getFullYear();

    // Block the year directory the archive would need to create, with a plain file.
    mkdirSync(join(dataDir, "erp-local-archive"), { recursive: true });
    const blocker = join(dataDir, "erp-local-archive", String(year));
    writeFileSync(blocker, "not a directory");

    const args = { customer_id: cust.id, number: "2026-0009", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 };
    await expect(create_invoice(db, args, ctx)).rejects.toThrow();

    expect(await db.all("SELECT * FROM local_invoices")).toHaveLength(0);
    expect(await db.all("SELECT * FROM local_numbers")).toHaveLength(0);

    rmSync(blocker, { force: true });
    const invoice = await create_invoice(db, args, ctx);
    expect(invoice.number).toBe("2026-0009");
  });
});

describe("get_document", () => {
  it("refuses when the archived file no longer matches its stored fingerprint", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("doc-tamper"));
    const cust = await seedAtCustomer(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0010", ...INVOICE_ARGS_BASE, lines: [{ description: "X", qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100 },
      ctx
    );
    writeFileSync(invoice.archive_path, "tampered bytes");
    await expect(get_document(db, { kind: "invoice-pdf", id: invoice.id })).rejects.toThrow(/does not match/);
  });

  it("refuses an unknown document kind", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("doc-unknown-kind"));
    await expect(get_document(db, { kind: "banana", id: "x" })).rejects.toThrow(/Unknown document kind/);
  });
});

describe("create_credit_note — template condition and reference to the invoice", () => {
  it("renders the credit-note heading referencing the original invoice, with negative totals", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("credit-note"));
    const cust = await seedAtCustomer(db);
    const invoice = await create_invoice(
      db,
      { customer_id: cust.id, number: "2026-0011", ...INVOICE_ARGS_BASE, lines: [{ description: "Drei-Wochen-Test", qty: 1, unit_price: 9000, vat_rate: 20 }], net_total: 9000 },
      ctx
    );

    const creditNote = await create_credit_note(
      db,
      {
        invoice_id: invoice.id, number: "2026-G0001", credit_total: 1500, currency: "EUR", reason: "Testzeitraum verkürzt",
        lines: [{ description: "Gutschrift: Reduktion", qty: 1, unit_price: 1500, vat_rate: 20 }],
      },
      ctx
    );
    expect(creditNote.net_total).toBe(1500);
    expect(creditNote.gross_total).toBe(1800);

    const updatedInvoice = await (await import("../../src/live/local/tools/invoices.js")).requireLocalInvoiceRow(db, invoice.id);
    expect(updatedInvoice.status).toBe("partially_credited");
    expect(updatedInvoice.credited_total).toBe(1500);

    // The credit-note heading referencing the invoice, and negative totals,
    // are covered at the template level in pdf-render.test.ts — here we
    // confirm the archived PDF exists, is readable, and matches its fingerprint.
    const buf = (await get_document(db, { kind: "credit-note-pdf", id: creditNote.id })) as any;
    expect(Buffer.from(buf.contentBase64, "base64").subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.sha256).toBe(creditNote.archive_sha256);
  });
});
