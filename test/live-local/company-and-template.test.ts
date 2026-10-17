import { describe, it, expect } from "vitest";
import { parseLiveCompany, addressOneLine } from "../../src/live/local/company-file.js";
import { parseTemplate, loadTemplateFile, DEFAULT_TEMPLATE_PATH, requireDocumentSupported } from "../../src/live/local/template.js";
import { MUSTER_COMPANY } from "./fixtures.js";

describe("parseLiveCompany — fail whole", () => {
  it("accepts a complete, valid company file", () => {
    expect(() => parseLiveCompany(MUSTER_COMPANY)).not.toThrow();
  });

  it("refuses a missing uid", () => {
    const bad = { ...MUSTER_COMPANY, uid: "" };
    expect(() => parseLiveCompany(bad)).toThrow(/uid/);
  });

  it("refuses an invalid vat_mode", () => {
    const bad = { ...MUSTER_COMPANY, vat_mode: "flat_rate" };
    expect(() => parseLiveCompany(bad)).toThrow(/vat_mode/);
  });

  it("refuses a non-2-letter address.country_code", () => {
    const bad = { ...MUSTER_COMPANY, address: { ...MUSTER_COMPANY.address, country_code: "AUT" } };
    expect(() => parseLiveCompany(bad)).toThrow(/country_code/);
  });
});

describe("addressOneLine", () => {
  it("joins street · zip city · country", () => {
    expect(addressOneLine(MUSTER_COMPANY.address)).toBe("MUSTER-Straße 1 · 1010 Wien · Österreich");
  });
});

describe("default template", () => {
  it("loads and validates the bundled rechnung-de v1", () => {
    const t = loadTemplateFile(DEFAULT_TEMPLATE_PATH);
    expect(t.template).toBe("rechnung-de");
    expect(t.version).toBe("1");
    expect(t.documents).toEqual(expect.arrayContaining(["invoice", "credit_note"]));
  });

  it("requireDocumentSupported passes for invoice and credit_note, refuses an unsupported kind", () => {
    const t = loadTemplateFile(DEFAULT_TEMPLATE_PATH);
    expect(() => requireDocumentSupported(t, "invoice")).not.toThrow();
    expect(() => requireDocumentSupported(t, "credit_note")).not.toThrow();
    // @ts-expect-error — intentionally invalid kind for this test
    expect(() => requireDocumentSupported(t, "delivery_note")).toThrow(/does not support/);
  });
});

describe("parseTemplate — fail whole", () => {
  it("refuses an empty blocks list", () => {
    expect(() => parseTemplate({ template: "t", version: "1", language: "de", documents: ["invoice"], page: {}, texts: {}, blocks: [] })).toThrow(/blocks/);
  });
  it("refuses a missing template id", () => {
    expect(() => parseTemplate({ version: "1", language: "de", documents: ["invoice"], page: {}, texts: {}, blocks: [{}] })).toThrow(/template/);
  });
});
