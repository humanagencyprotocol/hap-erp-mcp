/**
 * The document date (Andreas, 2026-10-18): `document_date` comes WITH the
 * request — this connector never substitutes "now" for it. It is printed on
 * the invoice/credit note and used to compute the due date. `preview_invoice`
 * accepts any date (an approver should be able to see the PDF as it would
 * print); `create_invoice`/`create_credit_note` refuse a date that is not
 * "today" — see `requireDocumentDateIsToday` — because an approved preview
 * must still match the document `create_*` actually issues (see
 * pdf-render.ts's determinism docstring).
 *
 * "Today" is a calendar date in a specific place, not a UTC instant: this
 * connector uses the company file's own `timezone` (IANA name, e.g.
 * "Europe/Vienna") if the person set one, and defaults to Europe/Vienna
 * otherwise (Suveren's home jurisdiction) — never the server process's local
 * timezone, which could be anything depending on where this connector happens
 * to run.
 *
 * Format-only validation (`validateDocumentDate`, `documentDateToUTCDate`) is
 * shared with the simulation's own invoicing — see ../../date.ts; the "must
 * be today" rule here is specific to this live adapter.
 */
import { validateDocumentDate, documentDateToUTCDate } from "../../date.js";

export { validateDocumentDate, documentDateToUTCDate };

export const DEFAULT_TIMEZONE = "Europe/Vienna";

/** True if `tz` is a timezone name `Intl` recognizes. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The ISO calendar date ("YYYY-MM-DD") `now` falls on in timezone `tz`. */
export function todayInTimezone(tz: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD directly — no manual reassembly needed.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Refuses unless `documentDate` is today's calendar date in `tz`. Issuing
 * (create_invoice/create_credit_note) calls this; previewing does not — see
 * this module's docstring.
 */
export function requireDocumentDateIsToday(documentDate: string, tz: string, now: Date = new Date()): void {
  const today = todayInTimezone(tz, now);
  if (documentDate !== today) {
    throw new Error(
      `Refused: document_date is dated ${documentDate}, today is ${today} — propose it again with today's date. Nothing was issued.`
    );
  }
}
