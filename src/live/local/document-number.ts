/**
 * The one format rule for every request-supplied document number in Local —
 * invoices, credit notes and quotes. The number names the archived PDF
 * (archive.ts), so it must be a plain file name: 1–64 letters, digits, ".",
 * "_" or "-", starting and ending with a letter or digit, no ".." anywhere.
 * That rules out path separators, absolute paths, traversal and whitespace.
 * The series format itself (e.g. `<PREFIX>-YYYY-NNN`) is the caller's brief,
 * not this connector's.
 *
 * Checked BEFORE any number reservation or archive write: a refused number is
 * never used and nothing is issued. (erp-mcp ≤ 0.9.5 only trimmed invoice and
 * credit-note numbers, so `../x` reached the archive path.)
 */
const DOCUMENT_NUMBER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export function isSafeDocumentNumber(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_NUMBER_PATTERN.test(value) && !value.includes("..");
}

/** Refuses a malformed number; `what` names the document ("invoice", "credit note", "quote"). */
export function requireSafeDocumentNumber(value: unknown, what: string): string {
  if (!isSafeDocumentNumber(value)) {
    throw new Error(
      `Refused: ${what} number ${JSON.stringify(value)} is malformed — use 1–64 letters, digits, ".", "_" or "-", ` +
        `starting and ending with a letter or digit, no "..". Nothing was issued.`
    );
  }
  return value;
}
