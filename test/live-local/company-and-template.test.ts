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

describe("parseLiveCompany — timezone", () => {
  it("defaults to Europe/Vienna when absent", () => {
    expect(parseLiveCompany(MUSTER_COMPANY).timezone).toBe("Europe/Vienna");
  });

  it("accepts an explicit valid IANA timezone", () => {
    const withTz = { ...MUSTER_COMPANY, timezone: "America/New_York" };
    expect(parseLiveCompany(withTz).timezone).toBe("America/New_York");
  });

  it("refuses an unrecognized timezone name", () => {
    const bad = { ...MUSTER_COMPANY, timezone: "Not/A_Zone" };
    expect(() => parseLiveCompany(bad)).toThrow(/timezone/);
  });

  it("refuses an empty-string timezone", () => {
    const bad = { ...MUSTER_COMPANY, timezone: "" };
    expect(() => parseLiveCompany(bad)).toThrow(/timezone/);
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

describe("settings paths and emptied fields (found 2026-10-18 on the first real setup)", () => {
  it("a company file path starting with ~ is read from the home directory", async () => {
    const { expandHome } = await import("../../src/live/local/paths");
    const { homedir } = await import("node:os");
    expect(expandHome("~/Documents/x.json")).toBe(`${homedir()}/Documents/x.json`);
    expect(expandHome("/abs/x.json")).toBe("/abs/x.json");
    expect(expandHome("~")).toBe(homedir());
  });

  it("an emptied register field means no register line, not an error", async () => {
    const { parseLiveCompany } = await import("../../src/live/local/company-file");
    const base = {
      name: "Suveren", owner: "MUSTER", uid: "ATU00000000", email: "a@b.at", web: "x",
      address: { street: "MUSTER-Straße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
      bank: { name: "B", iban: "AT00", bic: "X" }, default_payment_term_days: 14, vat_mode: "normal",
    };
    expect(parseLiveCompany({ ...base, register: "" }).register).toBeNull();
    expect(parseLiveCompany({ ...base, register: "  " }).register).toBeNull();
    expect(parseLiveCompany({ ...base, register: "GISA 1" }).register).toBe("GISA 1");
  });
});
