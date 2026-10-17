import { describe, it, expect } from "vitest";
import { get, substitute, resolveText, evalWhen, formatMoney, formatDate } from "../../src/live/local/template-engine.js";

describe("get", () => {
  it("reads a dotted path out of a nested object", () => {
    expect(get({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });
  it("returns undefined for a missing path instead of throwing", () => {
    expect(get({ a: {} }, "a.b.c")).toBeUndefined();
  });
});

describe("formatMoney", () => {
  it("formats German-style with thousands separator and comma decimals", () => {
    expect(formatMoney(9000)).toBe("€ 9.000,00");
    expect(formatMoney(10800)).toBe("€ 10.800,00");
  });
  it("places the minus sign after the € symbol for negative amounts (credit notes)", () => {
    expect(formatMoney(-1500)).toBe("€ -1.500,00");
  });
});

describe("formatDate", () => {
  it("formats an ISO date as DD.MM.YYYY", () => {
    expect(formatDate("2026-10-17")).toBe("17.10.2026");
  });
  it("accepts a Date instance", () => {
    expect(formatDate(new Date("2026-10-31T00:00:00Z"))).toBe("31.10.2026");
  });
});

describe("substitute", () => {
  it("replaces a plain variable", () => {
    expect(substitute("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });
  it("applies the |money filter", () => {
    expect(substitute("{{summe.netto|money}}", { summe: { netto: 9000 } })).toBe("€ 9.000,00");
  });
  it("applies the |date filter", () => {
    expect(substitute("{{dokument.datum|date}}", { dokument: { datum: "2026-10-17" } })).toBe("17.10.2026");
  });
  it("renders an unknown/undefined path as empty string, not 'undefined'", () => {
    expect(substitute("[{{missing.path}}]", {})).toBe("[]");
  });
  it("throws on an unknown filter", () => {
    expect(() => substitute("{{x|bogus}}", { x: 1 })).toThrow(/unknown filter/);
  });
});

describe("resolveText", () => {
  const texts = {
    "title.invoice": "Rechnung",
    "title.credit_note": "Gutschrift zu {{gutschrift.zu_rechnung.nummer}}",
  };
  it("resolves a key template against vars, then substitutes the text's own variables", () => {
    expect(resolveText("title.{{dokument.art}}", { dokument: { art: "invoice" } }, texts)).toBe("Rechnung");
    expect(
      resolveText("title.{{dokument.art}}", { dokument: { art: "credit_note" }, gutschrift: { zu_rechnung: { nummer: "2026-0001" } } }, texts)
    ).toBe("Gutschrift zu 2026-0001");
  });
  it("throws naming the resolved key when it is not in texts", () => {
    expect(() => resolveText("title.{{dokument.art}}", { dokument: { art: "nope" } }, texts)).toThrow(/title\.nope/);
  });
});

describe("evalWhen", () => {
  it("evaluates a bare path as truthy", () => {
    expect(evalWhen("kunde.uid", { kunde: { uid: "ATU1" } })).toBe(true);
    expect(evalWhen("kunde.uid", { kunde: { uid: null } })).toBe(false);
  });
  it("evaluates == against a quoted literal", () => {
    expect(evalWhen("dokument.art == 'credit_note'", { dokument: { art: "credit_note" } })).toBe(true);
    expect(evalWhen("dokument.art == 'credit_note'", { dokument: { art: "invoice" } })).toBe(false);
  });
  it("evaluates !=", () => {
    expect(evalWhen("steuer.art != 'normal'", { steuer: { art: "kleinunternehmer" } })).toBe(true);
    expect(evalWhen("steuer.art != 'normal'", { steuer: { art: "normal" } })).toBe(false);
  });
});
