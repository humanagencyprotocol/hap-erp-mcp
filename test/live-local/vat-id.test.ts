import { describe, it, expect } from "vitest";
import { checkVatIdFormat, normaliseVatId, VAT_ID_PATTERN_COUNTRIES } from "../../src/live/local/vat-id.js";
import { EU_COUNTRIES } from "../../src/live/local/tax.js";

// One well-formed number per VIES prefix (synthetic — format only, not real VAT IDs).
const GOOD: Record<string, string> = {
  AT: "ATU12345678", BE: "BE0123456789", BG: "BG123456789", CY: "CY12345678L", CZ: "CZ12345678",
  DE: "DE123456789", DK: "DK12345678", EE: "EE123456789", GR: "EL123456789", ES: "ESA1234567B",
  FI: "FI12345678", FR: "FRAB123456789", HR: "HR12345678901", HU: "HU12345678", IE: "IE1234567WA",
  IT: "IT12345678901", LT: "LT123456789", LU: "LU12345678", LV: "LV12345678901", MT: "MT12345678",
  NL: "NL123456789B01", PL: "PL1234567890", PT: "PT123456789", RO: "RO1234567", SE: "SE123456789001",
  SI: "SI12345678", SK: "SK1234567890", XI: "XI123456789",
};

describe("VAT-ID format (§3.3 step 2)", () => {
  it("has a good example for every EU state and XI, and a pattern for each", () => {
    for (const c of EU_COUNTRIES) expect(GOOD[c], c).toBeDefined();
    expect(VAT_ID_PATTERN_COUNTRIES).toHaveLength(28); // 27 states (GR as EL) + XI
  });

  for (const [country, uid] of Object.entries(GOOD)) {
    it(`${country}: good / wrong prefix / wrong pattern`, () => {
      expect(checkVatIdFormat(country, uid).format).toBe("ok");
      const otherPrefix = country === "AT" ? "DE" : "AT";
      expect(checkVatIdFormat(country, otherPrefix + uid.slice(2)).format).toBe("wrong_prefix");
      expect(checkVatIdFormat(country, uid.slice(0, 2) + "1").format).toBe("wrong_pattern");
    });
  }

  it("GR uses the VIES prefix EL — GR… is a wrong prefix", () => {
    expect(checkVatIdFormat("GR", "EL123456789")).toMatchObject({ format: "ok", prefix: "EL", number: "123456789" });
    expect(checkVatIdFormat("GR", "GR123456789").format).toBe("wrong_prefix");
  });

  it("normalises: upper case, no spaces / dots / dashes", () => {
    expect(normaliseVatId("atu 123.456-78")).toBe("ATU12345678");
    expect(checkVatIdFormat("at", "atu 123.456-78")).toMatchObject({ uid: "ATU12345678", format: "ok" });
  });

  it("a non-EU country passes as not_applicable, stored as given (normalised)", () => {
    expect(checkVatIdFormat("CH", "CHE-123.456.789 MWST")).toMatchObject({ format: "not_applicable", uid: "CHE123456789MWST" });
    expect(checkVatIdFormat("US", "anything").format).toBe("not_applicable");
  });
});
