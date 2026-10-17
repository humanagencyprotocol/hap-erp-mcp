/**
 * Shared ISO calendar-date ("YYYY-MM-DD") handling for a document's own
 * `document_date` — used by both the simulation's own invoicing and live
 * mode's "local" adapter (see money.ts for the equivalent split on money
 * values). The "must be today" / timezone rule is local-live-only and lives
 * in live/local/date.ts, which builds on these.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates `value` is a plain ISO calendar date ("YYYY-MM-DD") denoting a
 * real calendar day (rejects e.g. "2026-02-30", which `Date` would otherwise
 * silently roll over to March 2nd). Returns the normalized string.
 */
export function validateDocumentDate(value: unknown, field = "document_date"): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new Error(`${field} is required and must be an ISO date "YYYY-MM-DD" (e.g. "2026-10-18"), got ${JSON.stringify(value)}.`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} ${JSON.stringify(value)} is not a real calendar date.`);
  }
  return value;
}

/** A validated document date, as a fixed UTC midnight `Date` — never "now". */
export function documentDateToUTCDate(documentDate: string): Date {
  return new Date(`${documentDate}T00:00:00.000Z`);
}
