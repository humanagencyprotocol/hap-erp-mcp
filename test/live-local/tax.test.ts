import { describe, it, expect } from "vitest";
import { deriveTaxMode, refuseIfInvalidTaxMode, EU_COUNTRIES } from "../../src/live/local/tax.js";

const base = { vatMode: "normal" as const, homeCountryCode: "AT", customerCountryCode: "AT", customerUid: "ATU12345678" };

describe("deriveTaxMode", () => {
  it("is normal for a home-country customer under the normal VAT setting", () => {
    expect(deriveTaxMode(base)).toBe("normal");
  });

  it("is reverse_charge for an EU customer outside the home country, with a UID", () => {
    expect(deriveTaxMode({ ...base, customerCountryCode: "DE", customerUid: "DE123456789" })).toBe("reverse_charge");
  });

  it("is NOT reverse_charge for a non-EU customer, even with a UID-looking value", () => {
    expect(deriveTaxMode({ ...base, customerCountryCode: "CH", customerUid: "CHE123456789" })).toBe("normal");
  });

  it("is NOT reverse_charge for an EU customer without a UID — falls through to normal/kleinunternehmer", () => {
    expect(deriveTaxMode({ ...base, customerCountryCode: "DE", customerUid: null })).toBe("normal");
  });

  it("is kleinunternehmer when the company file says so, for a home-country customer", () => {
    expect(deriveTaxMode({ ...base, vatMode: "kleinunternehmer" })).toBe("kleinunternehmer");
  });

  it("EU cross-border with UID wins over kleinunternehmer (reverse charge is still reverse charge)", () => {
    expect(deriveTaxMode({ ...base, vatMode: "kleinunternehmer", customerCountryCode: "DE", customerUid: "DE123456789" })).toBe("reverse_charge");
  });

  it("the home country itself is in the EU set but never triggers reverse charge against itself", () => {
    expect(EU_COUNTRIES.has("AT")).toBe(true);
    expect(deriveTaxMode({ ...base, customerCountryCode: "AT", customerUid: "ATU12345678" })).toBe("normal");
  });
});

describe("refuseIfInvalidTaxMode", () => {
  it("refuses an EU cross-border customer with no UID (reverse charge requires one)", () => {
    expect(() => refuseIfInvalidTaxMode({ ...base, customerCountryCode: "DE", customerUid: null }, 1000)).toThrow(/UID/);
  });

  // Andreas's decision on review finding 3 (option A): outside the EU VAT area
  // is refused, with or without a VAT ID (consumer case: see tax.ts).
  it("refuses a customer outside the EU VAT area — CH, GB, US, XI — with or without a VAT ID", () => {
    for (const country of ["CH", "GB", "US", "XI", "xi"]) {
      for (const uid of [null, `${country}123456789`]) {
        expect(() => refuseIfInvalidTaxMode({ ...base, customerCountryCode: country, customerUid: uid }, 1000)).toThrow(
          `Refused: Tax treatment for customers outside the EU is not supported yet (customer country ${country}) — nothing was issued.`
        );
      }
    }
  });

  it("home country and EU customers are unchanged", () => {
    expect(() => refuseIfInvalidTaxMode({ ...base, customerCountryCode: "AT", customerUid: null }, 1000)).not.toThrow();
    expect(() => refuseIfInvalidTaxMode({ ...base, customerCountryCode: "DE", customerUid: "DE123456789" }, 1000)).not.toThrow();
  });

  it("refuses any customer with no UID once the gross total exceeds €10,000", () => {
    expect(() => refuseIfInvalidTaxMode({ ...base, customerUid: null }, 10000.01)).toThrow(/10,000/);
  });

  it("does not refuse at exactly €10,000 with no UID", () => {
    expect(() => refuseIfInvalidTaxMode({ ...base, customerUid: null }, 10000)).not.toThrow();
  });

  it("does not refuse above €10,000 when a UID is present", () => {
    expect(() => refuseIfInvalidTaxMode({ ...base, customerUid: "ATU12345678" }, 50000)).not.toThrow();
  });
});
