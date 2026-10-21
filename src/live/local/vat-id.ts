/**
 * Offline, deterministic VAT-ID format check (docs/local-production-contract.md
 * §3.3 step 2). Runs before anything else touches the VAT ID, and before the
 * VIES call (vies.ts) — a VAT ID that cannot be right is never sent outside.
 *
 * A VAT ID is normalised (upper case, spaces / dots / dashes removed), then
 * must start with the VIES prefix of the customer's country (`GR` → `EL`,
 * `XI` = Northern Ireland, else the country code) and match that country's
 * pattern below. A VAT ID for a country outside the EU (and not `XI`) is
 * stored as given (normalised) — format `not_applicable`, VIES `not_applicable`.
 *
 * Patterns follow the European Commission's published VIES formats; they are
 * the part after the two-letter prefix.
 */
import { EU_COUNTRIES } from "./tax.js";

export type VatIdFormat = "ok" | "wrong_prefix" | "wrong_pattern" | "not_applicable";

const PATTERNS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-WY][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^[1-9]\d{1,9}$/,
  SE: /^\d{10}01$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** Upper case, no spaces, dots or dashes. */
export function normaliseVatId(uid: string): string {
  return uid.toUpperCase().replace(/[\s.\-]/g, "");
}

/** True when VIES answers for this country: an EU member state or Northern Ireland (`XI`). */
export function isViesCountry(country: string): boolean {
  const c = country.toUpperCase();
  return EU_COUNTRIES.has(c) || c === "XI";
}

/** The two-letter prefix VIES uses for a country: GR → EL, else the country code. */
export function viesPrefix(country: string): string {
  const c = country.toUpperCase();
  return c === "GR" ? "EL" : c;
}

export interface VatIdCheck {
  uid: string;
  format: VatIdFormat;
  /** VIES prefix + the number part, when format is "ok". */
  prefix: string | null;
  number: string | null;
}

export function checkVatIdFormat(country: string, rawUid: string): VatIdCheck {
  const uid = normaliseVatId(rawUid);
  if (!isViesCountry(country)) return { uid, format: "not_applicable", prefix: null, number: null };
  const prefix = viesPrefix(country);
  if (!uid.startsWith(prefix)) return { uid, format: "wrong_prefix", prefix: null, number: null };
  const number = uid.slice(prefix.length);
  if (!PATTERNS[prefix].test(number)) return { uid, format: "wrong_pattern", prefix: null, number: null };
  return { uid, format: "ok", prefix, number };
}

/** The refusal for a malformed VAT ID — format check step of §3.3. */
export function refuseIfBadVatIdFormat(check: VatIdCheck, country: string): void {
  if (check.format === "wrong_prefix") {
    throw new Error(
      `Refused: VAT ID ${check.uid} does not start with ${viesPrefix(country)}, the prefix for country ${country.toUpperCase()}. Nothing was saved.`
    );
  }
  if (check.format === "wrong_pattern") {
    throw new Error(
      `Refused: VAT ID ${check.uid} does not match the format of a ${country.toUpperCase()} VAT ID. Nothing was saved.`
    );
  }
}

export const VAT_ID_PATTERN_COUNTRIES: readonly string[] = Object.keys(PATTERNS);
