/**
 * Tax mode derivation for a local invoice/credit note (Andreas, 2026-10-17):
 *
 *   reverse_charge   customer's country is an EU member state other than the
 *                    company's home country, AND the customer has a UID
 *   kleinunternehmer the company file says so (§ 6 Abs. 1 Z 27 UStG) — a
 *                    company-wide setting, not per-customer
 *   normal           otherwise
 *
 * Reverse charge is refused outright without a customer UID (never silently
 * downgraded to `normal`) — see refuseIfInvalid below.
 *
 * Customers outside the EU VAT area (Andreas's decision on review finding 3,
 * 2026-10-21, option A): any customer country other than the home country
 * and the EU member states — Northern Ireland (XI), CH, GB, US, … — is
 * REFUSED for invoices, quotes and quote → invoice conversion, with or
 * without a VAT ID. With a VAT ID (business customer) 20 % home VAT is wrong
 * (services: not taxable here; goods: export / intra-Community supply). Without
 * one (consumer) the right treatment depends on what is supplied (e.g. § 3a
 * Abs. 14 UStG catalogue services, export deliveries), which this connector
 * cannot tell — so it is refused too, consistent with the existing rule that
 * refuses an EU cross-border customer without UID rather than guessing.
 * Credit notes are not affected: they follow the invoice they correct.
 */

/** EU member states (2-letter ISO 3166-1 alpha-2), as of 2026. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR",
  "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

export type TaxMode = "normal" | "reverse_charge" | "kleinunternehmer";

export interface TaxModeInput {
  vatMode: "normal" | "kleinunternehmer";
  homeCountryCode: string;
  customerCountryCode: string | null;
  customerUid: string | null;
}

/**
 * Derives the tax mode. Does NOT itself refuse a missing UID for reverse
 * charge — that is `refuseIfInvalidTaxMode`'s job, so the caller gets one
 * clear refusal naming the actual problem instead of a silently wrong mode.
 */
export function deriveTaxMode(input: TaxModeInput): TaxMode {
  const { vatMode, homeCountryCode, customerCountryCode, customerUid } = input;
  const isEuCrossBorder =
    customerCountryCode !== null &&
    customerCountryCode !== homeCountryCode &&
    EU_COUNTRIES.has(customerCountryCode);

  if (isEuCrossBorder && customerUid) return "reverse_charge";
  if (vatMode === "kleinunternehmer") return "kleinunternehmer";
  return "normal";
}

/** True for a customer country that is neither the home country nor an EU member state (XI counts as outside). */
export function isOutsideEuVatArea(homeCountryCode: string, customerCountryCode: string | null): boolean {
  if (customerCountryCode === null) return false;
  const c = customerCountryCode.toUpperCase();
  return c !== homeCountryCode.toUpperCase() && !EU_COUNTRIES.has(c);
}

/**
 * Refuses the cases the law does not allow (or this connector does not support):
 * - a customer outside the EU VAT area (see module docstring).
 * - EU cross-border B2B with no customer UID (reverse charge needs one;
 *   falling back to `normal` would be wrong, not safe).
 * - gross total above €10,000 with no customer UID, regardless of tax mode.
 */
export function refuseIfInvalidTaxMode(input: TaxModeInput, grossTotal: number): void {
  const { homeCountryCode, customerCountryCode, customerUid } = input;
  if (isOutsideEuVatArea(homeCountryCode, customerCountryCode)) {
    throw new Error(
      `Refused: Tax treatment for customers outside the EU is not supported yet (customer country ${customerCountryCode}) — nothing was issued.`
    );
  }
  const isEuCrossBorder =
    customerCountryCode !== null &&
    customerCountryCode !== homeCountryCode &&
    EU_COUNTRIES.has(customerCountryCode);

  if (isEuCrossBorder && !customerUid) {
    throw new Error(
      `Refused: customer country ${customerCountryCode} is an EU member state other than ${homeCountryCode} — ` +
        "this is a reverse-charge case and requires the customer's UID. Nothing was issued."
    );
  }
  if (grossTotal > 10000 && !customerUid) {
    throw new Error(
      `Refused: gross total ${grossTotal.toFixed(2)} exceeds €10,000 and the customer has no UID. Nothing was issued.`
    );
  }
}
