/**
 * Write-once archive for issued invoice/credit-note PDFs:
 * <dataDir>/erp-local-archive/<year>/<number>.pdf — one shared numbering
 * namespace (see db.ts) means invoices and credit notes never collide on
 * this path even though they share one directory per year.
 *
 * `writeOnce` never overwrites an existing file (`wx` — exclusive create) and
 * is called BEFORE any database row is written: if it throws, nothing is
 * issued — no row, no number consumed (dispatch's callers must preserve that
 * ordering; see tools/invoices.ts).
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve, relative, isAbsolute, sep } from "path";

export function archiveDir(dataDir: string): string {
  return join(dataDir, "erp-local-archive");
}

/**
 * Defence in depth: the numbers are format-checked before this point
 * (document-number.ts), but a resolved archive path must also stay inside
 * the archive directory — refused otherwise, before anything is written.
 */
export function requireInsideArchive(dataDir: string, path: string): string {
  const root = resolve(archiveDir(dataDir));
  const rel = relative(root, resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refused: archive path ${path} is outside the archive directory ${root}. Nothing was issued.`);
  }
  return path;
}

export function archivePath(dataDir: string, year: number, number: string): string {
  return requireInsideArchive(dataDir, join(archiveDir(dataDir), String(year), `${number}.pdf`));
}

/**
 * Quotes (Part B): their own directory, never the invoices' year directories —
 * a quote number lives in its own series and must never be able to collide
 * with an invoice or credit-note file. One write-once file per revision:
 * <dataDir>/erp-local-archive/quotes/<year>/<number>-r<revision>.pdf
 */
export function quoteArchivePath(dataDir: string, year: number, number: string, revision: number): string {
  return requireInsideArchive(dataDir, join(archiveDir(dataDir), "quotes", String(year), `${number}-r${revision}.pdf`));
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface ArchivedFile {
  path: string;
  sha256: string;
}

/** Writes `buf` to `path`, refusing if it already exists. Throws (unmodified) on any other fs failure. */
export function writeOnce(path: string, buf: Buffer): ArchivedFile {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, buf, { flag: "wx" });
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      throw new Error(`Refused: archive file already exists at ${path} — an issued document is never overwritten.`);
    }
    throw new Error(`Refused: could not write the archive at ${path} (${err?.message ?? err}). Nothing was issued.`);
  }
  return { path, sha256: sha256(buf) };
}

/** Reads the archived file and verifies its sha256 still matches what was stored at issue time. */
export function readAndVerify(path: string, expectedSha256: string): Buffer {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err: any) {
    throw new Error(`Refused: could not read the archived document at ${path} (${err?.message ?? err}).`);
  }
  const actual = sha256(buf);
  if (actual !== expectedSha256) {
    throw new Error(
      `Refused: archived document at ${path} does not match its stored fingerprint (expected ${expectedSha256}, got ${actual}). Refusing to return it.`
    );
  }
  return buf;
}
