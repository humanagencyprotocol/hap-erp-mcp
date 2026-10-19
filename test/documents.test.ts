/**
 * get_document in simulation mode: the invoice / credit-note PDF rendered with
 * Local's own template, view-model and renderer. Text is asserted against the
 * resolved content tree (see test/live-local/pdf-render.test.ts for why — PDF
 * bytes carry glyph arrays, not ASCII), the bytes against %PDF and sha256.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { readFileSync, rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { callTool } from "../src/dispatch.js";
import { resolveSimDocument } from "../src/tools/documents.js";
import { resolveTemplate } from "../src/live/local/template.js";
import { resolveTemplateBlocks } from "../src/live/local/pdf-render.js";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
const { template } = resolveTemplate({});
let db: Db;
let dbPath: string;

beforeEach(async () => {
  dbPath = join(tmpdir(), `erp-docs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
  await callTool(db, "simulation", "load_simulation", { package: pkg });
});
afterEach(async () => { await db.close(); rmSync(dbPath, { force: true }); delete process.env.DATABASE_URL; });

async function issueInvoice() {
  const customers = (await callTool(db, "simulation", "find_customers", {})) as any[];
  return (await callTool(db, "simulation", "create_invoice", {
    customer_id: customers[0].id, currency: "EUR", net_total: 1234.5,
    lines: [{ description: "Spare part set", qty: 3, unit_price: 411.5, vat_rate: 20 }],
  })) as any;
}

const text = (vars: Record<string, unknown>) => JSON.stringify(resolveTemplateBlocks(template, vars).content);

describe("get_document (simulation) — invoice", () => {
  it("returns a PDF whose sha256 is the bytes' own, stable across reads", async () => {
    const invoice = await issueInvoice();
    const doc = (await callTool(db, "simulation", "get_document", { kind: "invoice-pdf", id: invoice.id })) as any;
    const bytes = Buffer.from(doc.contentBase64, "base64");
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(doc).toMatchObject({ filename: `${invoice.number}.pdf`, contentType: "application/pdf" });
    expect(doc.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const again = (await callTool(db, "simulation", "get_document", { kind: "invoice-pdf", id: invoice.number })) as any;
    expect(again.sha256).toBe(doc.sha256); // what the gateway seals is what it re-reads at execution
  });

  it("renders the invoice number, total and the package's company name", async () => {
    const invoice = await issueInvoice();
    const t = text((await resolveSimDocument(db, { kind: "invoice-pdf", id: invoice.id }, template)).vars);
    expect(t).toContain(invoice.number);
    expect(t).toContain("€ 1.481,40"); // gross: 1234.50 + 20 %
    expect(t).toContain(pkg.name);
    expect(t).not.toMatch(/simulat/i);
  });
});

describe("get_document (simulation) — credit note", () => {
  it("renders the credit note with its number, negative total and the invoice it corrects", async () => {
    const invoice = await issueInvoice();
    const note = (await callTool(db, "simulation", "create_credit_note", {
      invoice_id: invoice.id, credit_total: invoice.net_total, currency: "EUR", reason: "returned goods",
    })) as any;
    const doc = (await callTool(db, "simulation", "get_document", { kind: "credit-note-pdf", id: note.id })) as any;
    expect(Buffer.from(doc.contentBase64, "base64").subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const t = text((await resolveSimDocument(db, { kind: "credit-note-pdf", id: note.number }, template)).vars);
    expect(t).toContain(note.number);
    expect(t).toContain(invoice.number);
    expect(t).toContain("€ -1.481,40");
  });
});

describe("get_document (simulation) — refusals, same messages as Local", () => {
  it("unknown invoice id", async () => {
    await expect(callTool(db, "simulation", "get_document", { kind: "invoice-pdf", id: "nope" })).rejects.toThrow("Unknown invoice id: nope");
  });
  it("unknown credit note id", async () => {
    await expect(callTool(db, "simulation", "get_document", { kind: "credit-note-pdf", id: "nope" })).rejects.toThrow("Unknown credit note id: nope");
  });
  it("unknown kind", async () => {
    await expect(callTool(db, "simulation", "get_document", { kind: "banana", id: "x" })).rejects.toThrow(/Unknown document kind/);
  });
});
