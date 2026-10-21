/**
 * `erp-mcp export-invoices --month YYYY-MM --out <dir>` — everything the tax
 * advisor needs for one month: a CSV line per invoice/credit note, and a
 * copy of each archived PDF, read back through the same sha256 check
 * get_document uses (never a raw copy of whatever happens to be on disk).
 */
import { mkdirSync, existsSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import type { Db } from "../../db.js";
import { readAndVerify } from "./archive.js";
import type { LocalInvoiceRow, LocalCreditNoteRow } from "./tools/invoices.js";

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportRow {
  number: string;
  date: string;
  kind: "invoice" | "credit_note";
  customer: string;
  uid: string;
  country: string;
  net: number;
  vat: number;
  gross: number;
  tax_mode: string;
  credited_invoice: string;
  archive_path: string;
}

function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month must be YYYY-MM, got ${JSON.stringify(month)}`);
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const to = new Date(Date.UTC(y, m, 1)).toISOString();
  return { from, to };
}

export async function collectExportRows(db: Db, month: string): Promise<ExportRow[]> {
  const { from, to } = monthRange(month);

  // Customer name, VAT ID and country come from each document's own snapshot
  // (R1) — what it was issued to — never from the customer's current row.
  const invoices = await db.all<LocalInvoiceRow>(
    `SELECT * FROM local_invoices WHERE issued_at >= ? AND issued_at < ? ORDER BY issued_at`,
    [from, to]
  );
  const creditNotes = await db.all<LocalCreditNoteRow>(
    `SELECT * FROM local_credit_notes WHERE issued_at >= ? AND issued_at < ? ORDER BY issued_at`,
    [from, to]
  );

  const rows: ExportRow[] = [];
  for (const inv of invoices) {
    rows.push({
      number: inv.number, date: inv.issued_at, kind: "invoice", customer: inv.customer_name ?? "",
      uid: inv.customer_uid ?? "", country: inv.customer_country ?? "", net: inv.net_total, vat: inv.vat_total,
      gross: inv.gross_total, tax_mode: inv.tax_mode, credited_invoice: "", archive_path: inv.archive_path,
    });
  }
  for (const cn of creditNotes) {
    rows.push({
      number: cn.number, date: cn.issued_at, kind: "credit_note", customer: cn.customer_name ?? "",
      uid: cn.customer_uid ?? "", country: cn.customer_country ?? "", net: -cn.net_total, vat: -cn.vat_total,
      gross: -cn.gross_total, tax_mode: "", credited_invoice: cn.invoice_number, archive_path: cn.archive_path,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

export function rowsToCsv(rows: ExportRow[]): string {
  const header = ["number", "date", "kind", "customer", "uid", "country", "net", "vat", "gross", "tax_mode", "credited_invoice"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.number, r.date, r.kind, r.customer, r.uid, r.country, r.net, r.vat, r.gross, r.tax_mode, r.credited_invoice]
        .map(csvField)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

/** Writes export.csv and a verified copy of every row's PDF into `outDir`. Returns the row count. */
export async function exportInvoicesToDir(db: Db, month: string, outDir: string): Promise<number> {
  const rows = await collectExportRows(db, month);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, `invoices-${month}.csv`), rowsToCsv(rows), "utf8");

  for (const r of rows) {
    // Verified read (same sha256 check get_document does), written through so a copy is never byte-for-byte
    // trusted just because the source path looks right.
    const filename = `${r.number}.pdf`;
    const sha = await db.get<{ archive_sha256: string }>(
      r.kind === "invoice"
        ? "SELECT archive_sha256 FROM local_invoices WHERE number = ?"
        : "SELECT archive_sha256 FROM local_credit_notes WHERE number = ?",
      [r.number]
    );
    if (!sha) continue;
    readAndVerify(r.archive_path, sha.archive_sha256); // throws if the file no longer matches
    copyFileSync(r.archive_path, join(outDir, filename));
  }

  return rows.length;
}
