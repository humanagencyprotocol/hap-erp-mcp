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

/**
 * Windows reserved device names (any case, with or without an extension —
 * `CON.pdf` and `nul.2026` are the device too): such a file cannot be created
 * in the archive on Windows, so the number is refused on every platform.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function isSafeDocumentNumber(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DOCUMENT_NUMBER_PATTERN.test(value) &&
    !value.includes("..") &&
    !WINDOWS_RESERVED.test(value)
  );
}

/** Refuses a malformed number; `what` names the document ("invoice", "credit note", "quote"). */
export function requireSafeDocumentNumber(value: unknown, what: string): string {
  if (!isSafeDocumentNumber(value)) {
    throw new Error(
      `Refused: ${what} number ${JSON.stringify(value)} is malformed — use 1–64 letters, digits, ".", "_" or "-", ` +
        `starting and ending with a letter or digit, no "..", not a Windows device name (CON, NUL, COM1, …). Nothing was issued.`
    );
  }
  return value;
}
