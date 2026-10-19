/**
 * The live/local company file (ERP_LIVE_COMPANY_FILE) — the person's own real
 * company data: name, owner, address, UID, bank, default payment term, VAT
 * mode. Set by the person in the gateway's connector settings; the AI has no
 * tool to read or change it. Validated strictly and refused whole on the
 * first problem — same discipline as company.ts's simulation company file.
 */
import { expandHome } from "./paths.js";
import { readFileSync, statSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import { DEFAULT_TIMEZONE, isValidTimezone } from "./date.js";

export interface LiveCompanyBank {
  name: string;
  iban: string;
  bic: string;
}

export interface LiveCompanyAddress {
  street: string;
  zip: string;
  city: string;
  /** Display form, e.g. "Österreich" — used in the printed address block. */
  country: string;
  /** 2-letter ISO code, e.g. "AT" — used for the reverse-charge/home-country check. */
  country_code: string;
}

export interface LiveCompany {
  name: string;
  owner: string;
  address: LiveCompanyAddress;
  uid: string;
  email: string;
  web: string;
  register: string | null;
  bank: LiveCompanyBank;
  default_payment_term_days: number;
  vat_mode: "normal" | "kleinunternehmer";
  /**
   * IANA timezone (e.g. "Europe/Vienna") whose calendar date is "today" for
   * the create_invoice/create_credit_note document_date check (Andreas,
   * 2026-10-18) — never the server process's own local timezone. Optional;
   * defaults to "Europe/Vienna" (Suveren's home jurisdiction) if the person
   * does not set one.
   */
  timezone: string;
  /**
   * The company logo as SVG markup, read from the file the company file names
   * in `logo_svg` (a path, relative to the company file or with ~). Absent →
   * the template shows the company name as text.
   */
  logo_svg?: string;
}

const MAX_LOGO_BYTES = 512 * 1024;

function fail(path: string, msg: string): never {
  throw new Error(`Company file ${path}: ${msg}`);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Optional text: absent, null, or empty all mean "not set" (an emptied
 *  field in the company file is not an error — found 2026-10-18). */
function optionalStr(v: unknown): v is string | undefined {
  return v === undefined || v === null || (typeof v === "string" && (v.trim() === "" || str(v)));
}

/** Single-line address, e.g. "Hauptstraße 1 · 1010 Wien · Österreich" — for the sender line / letterhead. */
export function addressOneLine(a: LiveCompanyAddress): string {
  return `${a.street} · ${a.zip} ${a.city} · ${a.country}`;
}

export function parseLiveCompany(raw: unknown, path = "(inline)"): LiveCompany {
  if (!raw || typeof raw !== "object") fail(path, "must be a JSON object");
  const c = raw as Record<string, unknown>;

  if (!str(c.name)) fail(path, "`name` is required");
  if (!str(c.owner)) fail(path, "`owner` is required");
  if (!str(c.uid)) fail(path, "`uid` is required");
  if (!str(c.email)) fail(path, "`email` is required");
  if (!str(c.web)) fail(path, "`web` is required");
  if (!optionalStr(c.register)) fail(path, "`register` must be text or null");

  const addr = (c.address ?? {}) as Record<string, unknown>;
  if (!str(addr.street)) fail(path, "`address.street` is required");
  if (!str(addr.zip)) fail(path, "`address.zip` is required");
  if (!str(addr.city)) fail(path, "`address.city` is required");
  if (!str(addr.country)) fail(path, "`address.country` is required");
  if (!str(addr.country_code) || !/^[A-Z]{2}$/.test(addr.country_code as string)) {
    fail(path, "`address.country_code` must be a 2-letter ISO code, e.g. AT");
  }

  const bank = (c.bank ?? {}) as Record<string, unknown>;
  if (!str(bank.name)) fail(path, "`bank.name` is required");
  if (!str(bank.iban)) fail(path, "`bank.iban` is required");
  if (!str(bank.bic)) fail(path, "`bank.bic` is required");

  const term = c.default_payment_term_days;
  if (!Number.isInteger(term) || (term as number) <= 0) {
    fail(path, "`default_payment_term_days` must be a positive integer");
  }

  if (c.vat_mode !== "normal" && c.vat_mode !== "kleinunternehmer") {
    fail(path, "`vat_mode` must be \"normal\" or \"kleinunternehmer\"");
  }

  let timezone = DEFAULT_TIMEZONE;
  if (c.timezone !== undefined && c.timezone !== null) {
    if (!str(c.timezone)) fail(path, "`timezone`, if present, must be a non-empty string");
    if (!isValidTimezone(c.timezone as string)) fail(path, `\`timezone\` ${JSON.stringify(c.timezone)} is not a recognized IANA timezone`);
    timezone = c.timezone as string;
  }

  return {
    name: c.name as string,
    owner: c.owner as string,
    address: {
      street: addr.street as string,
      zip: addr.zip as string,
      city: addr.city as string,
      country: addr.country as string,
      country_code: (addr.country_code as string).toUpperCase(),
    },
    uid: c.uid as string,
    email: c.email as string,
    web: c.web as string,
    register: str(c.register) ? (c.register as string) : null,
    bank: { name: bank.name as string, iban: bank.iban as string, bic: bank.bic as string },
    default_payment_term_days: term as number,
    vat_mode: c.vat_mode as "normal" | "kleinunternehmer",
    timezone,
  };
}

export function loadLiveCompanyFile(path: string): LiveCompany {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path, `cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const company = parseLiveCompany(raw, path);
  const logoRef = (raw as Record<string, unknown>).logo_svg;
  if (logoRef === undefined || logoRef === null || logoRef === "") return company;
  if (!str(logoRef) || !/\.svg$/i.test(logoRef as string)) fail(path, "`logo_svg`, if present, must be a path to an .svg file");
  const logoPath = resolvePath(dirname(path), expandHome(logoRef as string));
  let svg: string;
  try {
    if (statSync(logoPath).size > MAX_LOGO_BYTES) fail(path, `\`logo_svg\` ${logoPath} is larger than 512 KB`);
    svg = readFileSync(logoPath, "utf8");
  } catch (err) {
    fail(path, `\`logo_svg\` ${logoPath} cannot be read (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!/<svg[\s>]/i.test(svg)) fail(path, `\`logo_svg\` ${logoPath} is not SVG markup`);
  return { ...company, logo_svg: svg };
}

/** Resolves ERP_LIVE_COMPANY_FILE — required in local live mode; throws clearly if unset or invalid. */
export function resolveLiveCompany(env: NodeJS.ProcessEnv = process.env): LiveCompany {
  const path = env.ERP_LIVE_COMPANY_FILE?.trim();
  if (!path) {
    throw new Error(
      "Refused: ERP_LIVE_COMPANY_FILE is required in live/local mode (the person's company data — name, address, UID, bank, VAT mode). Nothing was read or changed."
    );
  }
  return loadLiveCompanyFile(expandHome(path));
}
