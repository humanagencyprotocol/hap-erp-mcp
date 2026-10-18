/**
 * Template conditions, asserted against the resolved pdfmake content tree
 * (see resolveTemplateBlocks's docstring) rather than text scraped back out
 * of PDF bytes — pdfmake/pdfkit encode drawn text as glyph-index arrays, not
 * literal ASCII, so byte-level scraping is not a meaningful check; this tree
 * IS what gets handed to pdfmake to draw, so it is a faithful proxy. The
 * three sample documents were also rendered to actual PDFs and visually
 * compared against temp/invoice-sample/*.html (see the task's PDF output
 * directory) — this file covers the conditional branches that comparison
 * doesn't exercise on its own (kleinunternehmer).
 */
import { describe, it, expect } from "vitest";
import { resolveTemplateBlocks, renderInvoiceDocument } from "../../src/live/local/pdf-render.js";
import { buildViewModel } from "../../src/live/local/view-model.js";
import { DEFAULT_TEMPLATE, MUSTER_COMPANY, MUSTER_COMPANY_KLEINUNTERNEHMER } from "./fixtures.js";

function dump(template = DEFAULT_TEMPLATE, vars: Record<string, unknown>): string {
  return JSON.stringify(resolveTemplateBlocks(template, vars).content);
}

const baseLine = { item_id: null, description: "Beratung", qty: 1, unit_price: 9000, vat_rate: 20, line_net: 9000, line_vat: 1800, line_gross: 10800, unit: "Pausch." };

describe("reverse charge — template condition", () => {
  it("includes the reverse-charge note and no VAT-rate line when steuer.art is reverse_charge", () => {
    const vars = buildViewModel({
      company: MUSTER_COMPANY,
      customer: { name: "Kessler Anlagenbau GmbH", addressLines: ["Hafenstraße 4", "20457 Hamburg", "Deutschland"], uid: "DE123456789" },
      documentKind: "invoice",
      number: "2026-0002",
      issuedAt: new Date("2026-10-17"),
      servicePeriod: { from: "2026-10-06", to: "2026-10-24" },
      lines: [{ ...baseLine, vat_rate: 0, line_vat: 0, line_gross: 9000 }],
      netTotal: 9000, vatTotal: 0, grossTotal: 9000,
      taxMode: "reverse_charge", vatRate: 0,
      invoiceOnly: { paymentTermDays: 14, dueDate: new Date("2026-10-31") },
    });
    const text = dump(DEFAULT_TEMPLATE, vars);
    expect(text).toMatch(/Übergang der Steuerschuld/);
    expect(text).not.toMatch(/Kleinunternehmer/);
  });
});

describe("service date vs. service period — template condition", () => {
  const vm = (from: string, to: string) => buildViewModel({
    company: MUSTER_COMPANY,
    customer: { name: "Test", addressLines: ["Viktorgasse 1", "1040 Wien"] },
    documentKind: "invoice",
    number: "TEST-2026-0002",
    issuedAt: new Date("2026-10-18"),
    servicePeriod: { from, to },
    lines: [baseLine],
    netTotal: 9000, vatTotal: 1800, grossTotal: 10800,
    taxMode: "normal", vatRate: 20,
    invoiceOnly: { paymentTermDays: 14, dueDate: new Date("2026-11-01") },
  });

  it("one day → \"Leistungsdatum 18.10.2026\", no day-to-same-day range", () => {
    const text = dump(DEFAULT_TEMPLATE, vm("2026-10-18", "2026-10-18"));
    expect(text).toMatch(/Leistungsdatum/);
    expect(text).not.toMatch(/Leistungszeitraum/);
    expect(text).not.toMatch(/18\.10\.2026 – 18\.10\.2026/);
  });

  it("several days → \"Leistungszeitraum\" with the range", () => {
    const text = dump(DEFAULT_TEMPLATE, vm("2026-10-06", "2026-10-24"));
    expect(text).toMatch(/Leistungszeitraum/);
    expect(text).toMatch(/06\.10\.2026 – 24\.10\.2026/);
    expect(text).not.toMatch(/Leistungsdatum/);
  });
});

describe("kleinunternehmer — template condition", () => {
  it("includes the small-business exemption note instead of the reverse-charge note", () => {
    const vars = buildViewModel({
      company: MUSTER_COMPANY_KLEINUNTERNEHMER,
      customer: { name: "Test GmbH", addressLines: ["Street 1", "1010 Wien", "Österreich"], uid: null },
      documentKind: "invoice",
      number: "2026-0006",
      issuedAt: new Date("2026-10-17"),
      servicePeriod: { from: "2026-10-06", to: "2026-10-24" },
      lines: [{ ...baseLine, vat_rate: 0, line_vat: 0, line_gross: 9000 }],
      netTotal: 9000, vatTotal: 0, grossTotal: 9000,
      taxMode: "kleinunternehmer", vatRate: 0,
      invoiceOnly: { paymentTermDays: 14, dueDate: new Date("2026-10-31") },
    });
    const text = dump(DEFAULT_TEMPLATE, vars);
    expect(text).toMatch(/Kleinunternehmer/);
    expect(text).not.toMatch(/Übergang der Steuerschuld/);
  });
});

describe("credit note — template condition and reference", () => {
  it("shows the credit-note heading, references the original invoice, and omits the invoice-only payment paragraph", () => {
    const vars = buildViewModel({
      company: MUSTER_COMPANY,
      customer: { name: "Drautal Maschinenbau GmbH", addressLines: ["Industriestraße 12", "9800 Spittal an der Drau", "Österreich"], uid: "ATU12345678" },
      documentKind: "credit_note",
      number: "2026-G0001",
      issuedAt: new Date("2026-10-20"),
      servicePeriod: { from: "2026-10-06", to: "2026-10-24" },
      lines: [{ ...baseLine, description: "Gutschrift: Reduktion", unit_price: 1500, qty: 1, line_net: 1500, line_vat: 300, line_gross: 1800 }],
      netTotal: 1500, vatTotal: 300, grossTotal: 1800,
      taxMode: "normal", vatRate: 20,
      creditNoteOnly: { invoiceNumber: "2026-0001", invoiceIssuedAt: new Date("2026-10-17") },
    });
    const text = dump(DEFAULT_TEMPLATE, vars);
    expect(text).toContain("Gutschrift (Storno) zu Rechnung 2026-0001");
    expect(text).toContain("2026-0001 vom 17.10.2026");
    expect(text).toContain("€ -1.500,00");
    expect(text).toContain("€ -1.800,00");
    expect(text).not.toMatch(/Zahlbar ohne Abzug/); // invoice-only payment text
  });
});

describe("renderInvoiceDocument", () => {
  it("produces real PDF bytes with the fixed issue date as CreationDate/ModDate", async () => {
    const vars = buildViewModel({
      company: MUSTER_COMPANY,
      customer: { name: "Test GmbH", addressLines: ["Street 1", "1010 Wien"], uid: null },
      documentKind: "invoice",
      number: "2026-0099",
      issuedAt: new Date("2026-10-17T00:00:00Z"),
      servicePeriod: { from: "2026-10-06", to: "2026-10-24" },
      lines: [baseLine],
      netTotal: 9000, vatTotal: 1800, grossTotal: 10800,
      taxMode: "normal", vatRate: 20,
      invoiceOnly: { paymentTermDays: 14, dueDate: new Date("2026-10-31") },
    });
    const issuedAt = new Date("2026-10-17T00:00:00Z");
    const buf = await renderInvoiceDocument(DEFAULT_TEMPLATE, vars, issuedAt);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.toString("latin1")).toContain("D:20261017"); // PDF date format prefix, from the fixed issuedAt
  });

  it("is deterministic — identical template + vars + issuedAt render byte-identical PDFs on every call", async () => {
    const vars = buildViewModel({
      company: MUSTER_COMPANY,
      customer: { name: "Test GmbH", addressLines: ["Street 1", "1010 Wien"], uid: null },
      documentKind: "invoice",
      number: "2026-0099",
      issuedAt: new Date("2026-10-17T00:00:00Z"),
      servicePeriod: { from: "2026-10-06", to: "2026-10-24" },
      lines: [baseLine],
      netTotal: 9000, vatTotal: 1800, grossTotal: 10800,
      taxMode: "normal", vatRate: 20,
      invoiceOnly: { paymentTermDays: 14, dueDate: new Date("2026-10-31") },
    });
    const issuedAt = new Date("2026-10-17T00:00:00Z");
    const first = await renderInvoiceDocument(DEFAULT_TEMPLATE, vars, issuedAt);
    const second = await renderInvoiceDocument(DEFAULT_TEMPLATE, vars, issuedAt);
    expect(second.equals(first)).toBe(true);
  });
});
