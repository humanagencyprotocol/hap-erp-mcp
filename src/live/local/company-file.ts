/**
 * The live/local company file (ERP_LIVE_COMPANY_FILE) — the person's own real
 * company data: name, owner, address, UID, bank, default payment term, VAT
 * mode. Set by the person in the gateway's connector settings; the AI has no
 * tool to read or change it. Validated strictly and refused whole on the
 * first problem — same discipline as company.ts's simulation company file.
 */
import { readFileSync } from "fs";

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
}

function fail(path: string, msg: string): never {
  throw new Error(`Company file ${path}: ${msg}`);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function optionalStr(v: unknown): v is string | undefined {
  return v === undefined || v === null || str(v);
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
  if (!optionalStr(c.register)) fail(path, "`register`, if present, must be a non-empty string");

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
  };
}

export function loadLiveCompanyFile(path: string): LiveCompany {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path, `cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseLiveCompany(raw, path);
}

/** Resolves ERP_LIVE_COMPANY_FILE — required in local live mode; throws clearly if unset or invalid. */
export function resolveLiveCompany(env: NodeJS.ProcessEnv = process.env): LiveCompany {
  const path = env.ERP_LIVE_COMPANY_FILE?.trim();
  if (!path) {
    throw new Error(
      "Refused: ERP_LIVE_COMPANY_FILE is required in live/local mode (the person's company data — name, address, UID, bank, VAT mode). Nothing was read or changed."
    );
  }
  return loadLiveCompanyFile(path);
}
