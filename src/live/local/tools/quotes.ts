/**
 * Local quotes (Part B, docs/local-production-contract.md §4 as amended by
 * Andreas's decisions §12 D2/D3).
 *
 * A Local quote works like an invoice:
 *
 * - D2: the number comes WITH the request (from the agent, in the format its
 *   brief sets). Quotes have their own series (`local_quote_numbers`), never
 *   `local_numbers`; a number already used by a quote — or by an invoice or
 *   credit note — is refused, as is a malformed one. `document_date` follows
 *   the invoice rule: create_quote/update_quote refuse a date that is not
 *   today; preview_quote accepts any date.
 * - D3: there is no send step. create_quote renders and archives the quote PDF
 *   (write-once) and the quote is `issued`; the agent then emails that PDF by
 *   reference (`get_document {kind: "quote-pdf"}`) under its own mandate.
 *   Whether that email ran is NOT tracked here: this connector never learns
 *   whether another connector executed a call, and inferring it would make
 *   `status` claim something nobody recorded. So the status machine is
 *   `issued --create_invoice{quote_id}--> converted`.
 *
 * Revision rule (docs/contract.md): create_quote is revision 1; every
 * update_quote is the next revision with its own archived PDF
 * (`<number>-r<revision>.pdf`). A converted quote never changes.
 *
 * Order of side effects as invoices: refusals → render → one DB transaction
 * whose last step is the write-once archive file (deleted again if the
 * transaction fails). A refused call writes nothing and reserves no number;
 * a failed update_quote leaves no `-r<N>` file behind that would block the
 * next revision. Every write holds the Local lock (write-lock.ts).
 */
import { v4 as uuidv4 } from "uuid";
import { basename } from "path";
import type { Db } from "../../../db.js";
import { computeLineTotals, valuesMatch, refuse, INVOICE_VALUE_TOLERANCE } from "../../../money.js";
import { canonicalSha256 } from "../../../package-hash.js";
import type { InvoiceTemplate } from "../template.js";
import { requireDocumentSupported, resolveQuoteTemplate } from "../template.js";
import { renderInvoiceDocument } from "../pdf-render.js";
import { quoteArchivePath, writeOnce, removeArchived, readAndVerify, sha256 as sha256Buffer } from "../archive.js";
import { inTransaction, locked } from "../write-lock.js";
import { buildViewModel } from "../view-model.js";
import { deriveTaxMode, refuseIfInvalidTaxMode, type TaxMode } from "../tax.js";
import { validateDocumentDate, documentDateToUTCDate, requireDocumentDateIsToday } from "../date.js";
import { requireLocalCustomer } from "./customers.js";
import { requireSafeDocumentNumber } from "../document-number.js";
import { resolveLocalLines, type LocalLine } from "../lines.js";
import {
  snapshotFromCustomer,
  representativeVatRate,
  refuseIfVatContradictsTaxMode,
  requireByIdOrNumber,
  type CustomerSnapshot,
  type LocalCtx,
} from "./invoices.js";
import type { LocalToolHandler } from "../dispatch.js";

const HOME_CURRENCY = "EUR";

/** Optional `quoteTemplate` lets tests inject one; otherwise ERP_QUOTE_TEMPLATE / the bundled default. */
export type QuoteCtx = LocalCtx & { quoteTemplate?: InvoiceTemplate };

function quoteTemplateOf(ctx: QuoteCtx): InvoiceTemplate {
  return ctx.quoteTemplate ?? resolveQuoteTemplate(process.env).template;
}

export type LocalQuoteStatus = "issued" | "converted";

export interface LocalQuoteRow {
  id: string;
  number: string;
  customer_id: string;
  status: LocalQuoteStatus;
  currency: string;
  discount_pct: number;
  net_total: number;
  valid_until: string | null;
  notes: string | null;
  revision: number;
  created_at: string;
  updated_at: string | null;
  sent_at: string | null;
  document_date: string;
  archive_path: string;
  archive_sha256: string;
  template_id: string;
  template_version: string;
  template_fingerprint: string;
  invoice_id: string | null;
  ticket_id: string | null;
}

export interface LocalQuoteRevisionRow {
  id: string;
  quote_id: string;
  revision: number;
  lines: string; // JSON-encoded StoredQuoteLine[]
  discount_pct: number;
  net_total: number;
  currency: string;
  valid_until: string | null;
  notes: string | null;
  customer_name: string;
  customer_address_lines: string; // JSON-encoded string[]
  customer_country: string;
  customer_uid: string | null;
  customer_revision: number;
  customer_snapshot_source: "issued" | "migrated";
  ticket_id: string | null;
  created_at: string;
}

/** A quote line as stored on the revision snapshot and returned by get_quote. */
export interface StoredQuoteLine {
  item_id: string | null;
  description: string;
  qty: number;
  unit: string;
  unit_price: number;
  vat_rate: number;
  list_price: number | null;
  item_revision: number | null;
  line_net: number;
}

// --- D2: quote numbers come with the request ---

export function validateQuoteNumber(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      "Refused: number is required — a quote's number comes with the request (its own series, separate from " +
        "invoices and credit notes); this connector never assigns one. Nothing was issued."
    );
  }
  return requireSafeDocumentNumber(value, "quote");
}

/** Refuses a number already used by a quote, or by an invoice or credit note (never written, only read). */
async function requireQuoteNumberUnused(db: Db, number: string): Promise<void> {
  const quote = await db.get<{ number: string }>(
    "SELECT number FROM local_quote_numbers WHERE lower(number) = lower(?)",
    [number]
  );
  if (quote) {
    throw new Error(`Refused: quote number ${JSON.stringify(number)} has already been used (quote ${quote.number}). Nothing was issued.`);
  }
  const doc = await db.get<{ number: string; kind: string }>(
    "SELECT number, kind FROM local_numbers WHERE lower(number) = lower(?)",
    [number]
  );
  if (doc) {
    throw new Error(
      `Refused: ${JSON.stringify(number)} is already the number of ${doc.kind === "invoice" ? "an invoice" : "a credit note"} ` +
        `(${doc.number}) — quotes have their own series. Nothing was issued.`
    );
  }
}

// --- Shared preparation (create / update / preview) ---

function validateValidUntil(value: unknown, documentDate: string): string | null {
  if (value === undefined || value === null) return null;
  const v = validateDocumentDate(value);
  if (v < documentDate) {
    throw new Error(`Refused: valid_until ${v} is before the quote's date ${documentDate}. Nothing was issued.`);
  }
  return v;
}

function validateNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("notes must be a string");
  return value;
}

interface PreparedQuote {
  number: string;
  customerId: string;
  /** Read in this call; the only customer data rendered or stored on the revision. */
  customer: CustomerSnapshot;
  revision: number;
  documentDate: string;
  validUntil: string | null;
  notes: string | null;
  lines: LocalLine[];
  totals: ReturnType<typeof computeLineTotals>;
  taxMode: TaxMode;
}

/**
 * Validates and prices one quote revision. `existing` = update (number and
 * customer from the quote; omitted lines/valid_until/notes kept from its
 * current revision); otherwise a new quote (revision 1).
 */
async function prepareQuote(
  db: Db, args: Record<string, any>, ctx: LocalCtx, existing: LocalQuoteRow | null
): Promise<PreparedQuote> {
  const number = existing ? existing.number : validateQuoteNumber(args.number);
  const customerId = existing ? existing.customer_id : args.customer_id;
  const customerRow = await requireLocalCustomer(db, customerId);
  const customer = snapshotFromCustomer(customerRow);
  const documentDate = validateDocumentDate(args.document_date);

  if (args.currency !== HOME_CURRENCY) refuse("currency", args.currency, HOME_CURRENCY, "Local quotes are in EUR only.");
  if (args.discount_pct !== 0) {
    refuse("discount_pct", args.discount_pct, 0, "Local quotes price each line — put the agreed price in unit_price.");
  }

  let current: LocalQuoteRevisionRow | null = null;
  if (existing) current = await requireQuoteRevisionRow(db, existing, existing.revision);

  const rawLines = args.lines !== undefined ? args.lines : storedLinesAsInput(JSON.parse(current!.lines));
  const lines = await resolveLocalLines(db, rawLines);
  const totals = computeLineTotals(lines);
  if (!valuesMatch(args.value, totals.net_total, INVOICE_VALUE_TOLERANCE)) {
    refuse("value", args.value, totals.net_total, "Recomputed as sum(qty × unit_price), in cents, from the quote lines.");
  }

  const validUntil = args.valid_until !== undefined
    ? validateValidUntil(args.valid_until, documentDate)
    : current ? validateValidUntil(current.valid_until, documentDate) : null;
  const notes = args.notes !== undefined ? validateNotes(args.notes) : (current?.notes ?? null);

  // The tax treatment an invoice to this customer would have on the quote's
  // date — printed on the quote, and refused here exactly as on an invoice so
  // a quote is never issued that could not be invoiced as offered.
  const taxInput = {
    vatMode: ctx.company.vat_mode,
    homeCountryCode: ctx.company.address.country_code,
    customerCountryCode: customer.country,
    customerUid: customer.uid,
  };
  const taxMode = deriveTaxMode(taxInput);
  refuseIfInvalidTaxMode(taxInput, totals.gross_total);
  refuseIfVatContradictsTaxMode(lines, taxMode, "quote");

  return {
    number, customerId: customerRow.id, customer, revision: existing ? existing.revision + 1 : 1,
    documentDate, validUntil, notes, lines, totals, taxMode,
  };
}

/** Stored revision lines back into request-shaped lines (for an update that keeps them, and for conversion). */
export function storedLinesAsInput(lines: StoredQuoteLine[]): Array<Record<string, unknown>> {
  return lines.map((l) => ({
    ...(l.item_id ? { item_id: l.item_id } : {}),
    description: l.description,
    qty: l.qty,
    unit: l.unit,
    unit_price: l.unit_price,
    vat_rate: l.vat_rate,
  }));
}

/**
 * The one render path for a quote (R6): same pdfmake renderer as invoices,
 * creation date = document_date at UTC midnight, nothing reads "now". preview
 * and issue call this with the same prepared content → identical bytes.
 */
async function renderQuote(prepared: PreparedQuote, ctx: LocalCtx, template: InvoiceTemplate): Promise<Buffer> {
  const issuedAt = documentDateToUTCDate(prepared.documentDate);
  const vars = buildViewModel({
    company: ctx.company,
    customer: { name: prepared.customer.name, addressLines: prepared.customer.address_lines, uid: prepared.customer.uid },
    documentKind: "quote",
    number: prepared.number,
    issuedAt,
    lines: prepared.totals.lines.map((l, i) => ({ ...l, unit: prepared.lines[i].unit })),
    netTotal: prepared.totals.net_total,
    vatTotal: prepared.totals.vat_total,
    grossTotal: prepared.totals.gross_total,
    taxMode: prepared.taxMode,
    vatRate: representativeVatRate(prepared.totals.lines, prepared.totals.net_total, prepared.totals.vat_total),
    quoteOnly: { validUntil: prepared.validUntil, revision: prepared.revision },
  });
  return renderInvoiceDocument(template, vars, issuedAt);
}

function storedLines(prepared: PreparedQuote): StoredQuoteLine[] {
  return prepared.totals.lines.map((l, i) => ({
    item_id: prepared.lines[i].item_id,
    description: l.description,
    qty: l.qty,
    unit: prepared.lines[i].unit,
    unit_price: l.unit_price,
    vat_rate: l.vat_rate,
    list_price: prepared.lines[i].list_price,
    item_revision: prepared.lines[i].item_revision,
    line_net: l.line_net,
  }));
}

function documentYear(documentDate: string): number {
  return Number(documentDate.slice(0, 4));
}

/** Writes the revision snapshot + replaces the current line rows. Caller holds the transaction. */
async function writeRevision(db: Db, quoteId: string, prepared: PreparedQuote, ticketId: string | null, now: string): Promise<void> {
  const lines = storedLines(prepared);
  await db.run("DELETE FROM local_quote_lines WHERE quote_id = ?", [quoteId]);
  for (const l of lines) {
    await db.run(
      `INSERT INTO local_quote_lines (id, quote_id, item_id, description, qty, unit, unit_price, vat_rate, list_price, item_revision, line_net)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), quoteId, l.item_id, l.description, l.qty, l.unit, l.unit_price, l.vat_rate, l.list_price, l.item_revision, l.line_net]
    );
  }
  const c = prepared.customer;
  await db.run(
    `INSERT INTO local_quote_revisions (id, quote_id, revision, lines, discount_pct, net_total, currency, valid_until, notes,
       customer_name, customer_address_lines, customer_country, customer_uid, customer_revision, customer_snapshot_source,
       ticket_id, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`,
    [
      uuidv4(), quoteId, prepared.revision, JSON.stringify(lines), prepared.totals.net_total, HOME_CURRENCY,
      prepared.validUntil, prepared.notes, c.name, JSON.stringify(c.address_lines), c.country, c.uid, c.revision,
      ticketId, now,
    ]
  );
}

// --- Reads ---

export async function requireLocalQuote(db: Db, idOrNumber: unknown): Promise<LocalQuoteRow> {
  if (typeof idOrNumber !== "string" || !idOrNumber) throw new Error("id is required (quote id or number)");
  try {
    return await requireByIdOrNumber<LocalQuoteRow>(db, "local_quotes", idOrNumber, "quote");
  } catch (err) {
    if ((err as Error).message.startsWith("Unknown")) throw new Error(`Unknown quote: ${idOrNumber}`);
    throw err;
  }
}

export async function requireQuoteRevisionRow(db: Db, quote: LocalQuoteRow, revision: number): Promise<LocalQuoteRevisionRow> {
  const row = await db.get<LocalQuoteRevisionRow>(
    "SELECT * FROM local_quote_revisions WHERE quote_id = ? AND revision = ?",
    [quote.id, revision]
  );
  if (!row) throw new Error(`Unknown revision ${JSON.stringify(revision)} for quote ${quote.number}`);
  return row;
}

/** Revision rule (docs/contract.md): refused naming both revisions. */
export function requireQuoteAtRevision(quote: LocalQuoteRow, declared: unknown, nothing = "Nothing was saved."): void {
  if (declared !== quote.revision) {
    throw new Error(
      `Refused: Quote ${quote.number} is at revision ${quote.revision}; this request is for revision ${JSON.stringify(declared)}. ${nothing}`
    );
  }
}

function snapshotOfRevision(r: LocalQuoteRevisionRow): CustomerSnapshot {
  return {
    name: r.customer_name,
    address_lines: JSON.parse(r.customer_address_lines),
    country: r.customer_country,
    uid: r.customer_uid,
    revision: r.customer_revision,
    source: r.customer_snapshot_source,
  };
}

function quoteFilename(number: string, revision: number): string {
  return `${number}-r${revision}.pdf`;
}

/** The quote as tools return it: content of `revision` (default current), customer snapshot, archived document. */
async function quoteView(db: Db, quote: LocalQuoteRow, revision: number = quote.revision) {
  const r = await requireQuoteRevisionRow(db, quote, revision);
  const isCurrent = revision === quote.revision;
  return {
    id: quote.id,
    number: quote.number,
    customer_id: quote.customer_id,
    status: quote.status,
    revision: r.revision,
    currency: r.currency,
    discount_pct: r.discount_pct,
    net_total: r.net_total,
    valid_until: r.valid_until,
    notes: r.notes,
    customer: snapshotOfRevision(r),
    lines: JSON.parse(r.lines) as StoredQuoteLine[],
    // Only the current revision's PDF is served (get_document kind quote-pdf);
    // earlier revisions' PDFs stay archived on disk.
    document: isCurrent
      ? {
          filename: quoteFilename(quote.number, quote.revision),
          sha256: quote.archive_sha256,
          document_date: quote.document_date,
          template: `${quote.template_id} v${quote.template_version}`,
        }
      : null,
    invoice_id: quote.invoice_id,
    ticket_id: r.ticket_id,
    created_at: quote.created_at,
    updated_at: quote.updated_at,
  };
}

export async function get_quote(db: Db, args: Record<string, any>) {
  const quote = await requireLocalQuote(db, args.id);
  const revision = args.revision === undefined || args.revision === null ? quote.revision : args.revision;
  return quoteView(db, quote, revision);
}

export async function list_quotes(db: Db, args: Record<string, any>) {
  const { status, customer_id, limit = 50 } = args;
  const conditions: string[] = [];
  const params: any[] = [];
  if (status) { conditions.push("status = ?"); params.push(status); }
  if (customer_id) { conditions.push("customer_id = ?"); params.push(customer_id); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rows = await db.all<LocalQuoteRow>(`SELECT * FROM local_quotes ${where} ORDER BY created_at DESC, number DESC LIMIT ?`, params);
  return rows.map((q) => ({
    id: q.id, number: q.number, customer_id: q.customer_id, status: q.status, revision: q.revision,
    currency: q.currency, discount_pct: q.discount_pct, net_total: q.net_total, valid_until: q.valid_until,
    document_date: q.document_date, invoice_id: q.invoice_id, created_at: q.created_at, updated_at: q.updated_at,
  }));
}

// --- Writes ---

export const create_quote = locked(async function create_quote(db: Db, args: Record<string, any>, ctx: QuoteCtx) {
  const template = quoteTemplateOf(ctx);
  requireDocumentSupported(template, "quote");
  const prepared = await prepareQuote(db, args, ctx, null);
  requireDocumentDateIsToday(prepared.documentDate, ctx.company.timezone);
  await requireQuoteNumberUnused(db, prepared.number);

  const buffer = await renderQuote(prepared, ctx, template);
  const path = quoteArchivePath(ctx.dataDir, documentYear(prepared.documentDate), prepared.number, prepared.revision);
  const archived = { path, sha256: sha256Buffer(buffer) };

  const id = uuidv4();
  const now = new Date().toISOString();
  const year = documentYear(prepared.documentDate);
  let written: string | null = null;
  await inTransaction(db, async () => {
    await requireQuoteNumberUnused(db, prepared.number);
    // The connector's own ordinal within the year — bookkeeping for the
    // series table, never the number (which comes with the request, D2).
    const seq = ((await db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM local_quote_numbers WHERE year = ?", [year]))?.m ?? 0) + 1;
    await db.run("INSERT INTO local_quote_numbers (number, year, seq, quote_id) VALUES (?, ?, ?, ?)", [prepared.number, year, seq, id]);
    await db.run(
      `INSERT INTO local_quotes (id, number, customer_id, status, currency, discount_pct, net_total, valid_until, notes, revision,
         created_at, updated_at, document_date, archive_path, archive_sha256, template_id, template_version, template_fingerprint, ticket_id)
       VALUES (?, ?, ?, 'issued', ?, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, prepared.number, prepared.customerId, HOME_CURRENCY, prepared.totals.net_total, prepared.validUntil, prepared.notes,
        now, now, prepared.documentDate, archived.path, archived.sha256, template.template, template.version,
        canonicalSha256(template), args.ticket_id ?? null,
      ]
    );
    await writeRevision(db, id, prepared, args.ticket_id ?? null, now);
    writeOnce(path, buffer);
    written = path;
  }, () => { if (written) removeArchived(written); });

  return quoteView(db, await requireLocalQuote(db, id));
});

function refuseIfConverted(quote: LocalQuoteRow, invoiceNumber: string | null, nothing: string): void {
  if (quote.status === "converted") {
    throw new Error(
      `Refused: quote ${quote.number} was converted to invoice ${invoiceNumber ?? quote.invoice_id} — a converted quote never changes. ${nothing}`
    );
  }
}

async function invoiceNumberOf(db: Db, invoiceId: string | null): Promise<string | null> {
  if (!invoiceId) return null;
  return (await db.get<{ number: string }>("SELECT number FROM local_invoices WHERE id = ?", [invoiceId]))?.number ?? null;
}

export const update_quote = locked(async function update_quote(db: Db, args: Record<string, any>, ctx: QuoteCtx) {
  const template = quoteTemplateOf(ctx);
  requireDocumentSupported(template, "quote");
  // `revision` is required (review finding 5): omitted fields are kept from the
  // current revision, so an update must name the revision its approver saw —
  // otherwise it would silently build on another approval's change.
  if (!Number.isInteger(args.revision) || args.revision < 1) {
    throw new Error(
      "Refused: revision is required — the quote's current revision this change is for (get_quote returns it). Nothing was saved."
    );
  }
  const quote = await requireLocalQuote(db, args.id);
  refuseIfConverted(quote, await invoiceNumberOf(db, quote.invoice_id), "Nothing was saved.");
  requireQuoteAtRevision(quote, args.revision);

  const prepared = await prepareQuote(db, args, ctx, quote);
  requireDocumentDateIsToday(prepared.documentDate, ctx.company.timezone);

  const buffer = await renderQuote(prepared, ctx, template);
  const path = quoteArchivePath(ctx.dataDir, documentYear(prepared.documentDate), prepared.number, prepared.revision);
  const archived = { path, sha256: sha256Buffer(buffer) };

  const now = new Date().toISOString();
  let written: string | null = null;
  await inTransaction(db, async () => {
    await db.run(
      `UPDATE local_quotes SET net_total = ?, valid_until = ?, notes = ?, revision = ?, updated_at = ?, document_date = ?,
         archive_path = ?, archive_sha256 = ?, template_id = ?, template_version = ?, template_fingerprint = ?, ticket_id = ?
       WHERE id = ? AND revision = ? AND status = 'issued'`,
      [
        prepared.totals.net_total, prepared.validUntil, prepared.notes, prepared.revision, now, prepared.documentDate,
        archived.path, archived.sha256, template.template, template.version, canonicalSha256(template),
        args.ticket_id ?? null, quote.id, quote.revision,
      ]
    );
    const after = await db.get<{ revision: number }>("SELECT revision FROM local_quotes WHERE id = ?", [quote.id]);
    if (after?.revision !== prepared.revision) throw new Error(`Refused: quote ${quote.number} changed during this call. Nothing was saved.`);
    await writeRevision(db, quote.id, prepared, args.ticket_id ?? null, now);
    writeOnce(path, buffer);
    written = path;
  }, () => { if (written) removeArchived(written); });

  return quoteView(db, await requireLocalQuote(db, quote.id));
});

/**
 * Renders the quote PDF exactly as create_quote (no `id`) or update_quote
 * (`id`) would, WITHOUT issuing: no number reserved, nothing archived or
 * recorded. Any document_date is accepted. Same sha256 as the issued PDF for
 * the same arguments on the same day (R6).
 */
export async function preview_quote(db: Db, args: Record<string, any>, ctx: QuoteCtx) {
  const template = quoteTemplateOf(ctx);
  requireDocumentSupported(template, "quote");
  let existing: LocalQuoteRow | null = null;
  if (args.id !== undefined && args.id !== null) {
    existing = await requireLocalQuote(db, args.id);
    refuseIfConverted(existing, await invoiceNumberOf(db, existing.invoice_id), "Nothing was rendered.");
    if (args.revision !== undefined && args.revision !== null) requireQuoteAtRevision(existing, args.revision, "Nothing was rendered.");
  }
  const prepared = await prepareQuote(db, args, ctx, existing);
  const buffer = await renderQuote(prepared, ctx, template);
  return {
    filename: quoteFilename(prepared.number, prepared.revision),
    contentType: "application/pdf",
    contentBase64: buffer.toString("base64"),
    sha256: sha256Buffer(buffer),
    pages: approximatePageCount(buffer),
  };
}

/** get_document {kind: "quote-pdf", id}: the current revision's archived PDF, sha-verified. */
export async function quoteDocument(db: Db, idOrNumber: unknown) {
  const quote = await requireLocalQuote(db, idOrNumber);
  if (!quote.archive_path || !quote.archive_sha256) {
    throw new Error(`Refused: quote ${quote.number} has no issued PDF.`);
  }
  const buf = readAndVerify(quote.archive_path, quote.archive_sha256);
  return {
    filename: basename(quote.archive_path),
    contentType: "application/pdf",
    contentBase64: buf.toString("base64"),
    sha256: quote.archive_sha256,
  };
}

function approximatePageCount(buf: Buffer): number {
  const matches = buf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g);
  return matches ? matches.length : 1;
}

export const QUOTE_TOOL_HANDLERS: Readonly<Record<string, LocalToolHandler>> = {
  list_quotes: (db, args) => list_quotes(db, args),
  get_quote: (db, args) => get_quote(db, args),
  create_quote: create_quote,
  update_quote: update_quote,
  preview_quote: preview_quote,
};
