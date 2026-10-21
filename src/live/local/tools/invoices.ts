/**
 * Local invoicing — the first live system behind this connector's live
 * mode. German/Austrian invoicing law (Andreas, 2026-10-17): an issued
 * invoice is never changed or deleted; a correction or cancellation is a
 * CREDIT NOTE with its own number. The number comes WITH the request (no
 * auto-numbering) — the only thing this connector enforces is that it was
 * never used before, across invoices AND credit notes (one shared
 * namespace, see db.ts).
 *
 * Order of operations in create_invoice/create_credit_note matters: render
 * → archive write (write-once) → database transaction, in that order. If
 * the archive write fails, the function throws before any row exists and
 * before the number is reserved — "nothing is issued" is a consequence of
 * this ordering, not a separate check.
 *
 * `document_date` (Andreas, 2026-10-18) comes WITH the request on
 * create_invoice/preview_invoice/create_credit_note alike — one consistent
 * name for the printed date on either document kind — and is never replaced
 * by "now": that is what makes a rendered preview and the document actually
 * issued identical for the same arguments (see pdf-render.ts and date.ts).
 * `preview_invoice` accepts any date; `create_invoice`/`create_credit_note`
 * refuse one that is not today in the company's own calendar.
 */
import { v4 as uuidv4 } from "uuid";
import { basename } from "path";
import type { Db } from "../../../db.js";
import {
  computeLineTotals,
  valuesMatch,
  refuse,
  roundToCents,
  INVOICE_VALUE_TOLERANCE,
  type PricedInvoiceLine,
} from "../../../money.js";
import { canonicalSha256 } from "../../../package-hash.js";
import type { LiveCompany } from "../company-file.js";
import type { InvoiceTemplate } from "../template.js";
import { requireDocumentSupported } from "../template.js";
import { renderInvoiceDocument } from "../pdf-render.js";
import { archivePath, writeOnce, readAndVerify, sha256 as sha256Buffer } from "../archive.js";
import { buildViewModel, type LineForTemplate } from "../view-model.js";
import { deriveTaxMode, refuseIfInvalidTaxMode, type TaxMode } from "../tax.js";
import { validateDocumentDate, documentDateToUTCDate, requireDocumentDateIsToday } from "../date.js";
import { requireLocalCustomer, requireViesValidForReverseCharge, type LocalCustomer } from "./customers.js";
import { requireSafeDocumentNumber } from "../document-number.js";
import { resolveLocalLines, type LocalLine } from "../lines.js";
import {
  requireLocalQuote, requireQuoteRevisionRow, storedLinesAsInput, quoteDocument, type StoredQuoteLine,
} from "./quotes.js";

export interface LocalCtx {
  company: LiveCompany;
  template: InvoiceTemplate;
  dataDir: string;
}

const HOME_CURRENCY = "EUR";

/**
 * Snapshot first (R1, docs/local-production-contract.md §3.6): the customer
 * data an invoice or credit note was issued to, frozen on its row. Rendering
 * reads only this — never the customer row again — so a later change to the
 * customer cannot reach an issued document or a credit note on it.
 *
 * `issued`: taken when the document was issued. `migrated`: filled at
 * migration time for documents issued before snapshots existed — for those,
 * the archived PDF stays the legal original and the snapshot is a
 * best-effort copy (see db.ts, M-A2).
 */
export type CustomerSnapshotSource = "issued" | "migrated";

export interface CustomerSnapshot {
  name: string;
  address_lines: string[];
  country: string;
  uid: string | null;
  revision: number;
  source: CustomerSnapshotSource;
}

type CustomerRowWithRevision = LocalCustomer & { revision?: number };

export function snapshotFromCustomer(customer: CustomerRowWithRevision): CustomerSnapshot {
  return {
    name: customer.name,
    address_lines: JSON.parse(customer.address_lines),
    country: customer.country,
    uid: customer.uid,
    revision: customer.revision ?? 1,
    source: "issued",
  };
}

/** The snapshot stored on an invoice or credit note row. */
export function snapshotFromRow(row: LocalInvoiceRow | LocalCreditNoteRow): CustomerSnapshot {
  if (row.customer_name == null || row.customer_address_lines == null || row.customer_country == null) {
    throw new Error(`Document ${row.number} has no customer snapshot — the local DB migration did not run.`);
  }
  return {
    name: row.customer_name,
    address_lines: JSON.parse(row.customer_address_lines),
    country: row.customer_country,
    uid: row.customer_uid,
    revision: row.customer_revision,
    source: row.customer_snapshot_source,
  };
}

/** Column values for the snapshot columns, in SNAPSHOT_COLUMNS order. */
function snapshotParams(s: CustomerSnapshot): unknown[] {
  return [s.name, JSON.stringify(s.address_lines), s.country, s.uid, s.revision, s.source];
}

const SNAPSHOT_COLUMNS =
  "customer_name, customer_address_lines, customer_country, customer_uid, customer_revision, customer_snapshot_source";

function viewModelCustomer(s: CustomerSnapshot) {
  return { name: s.name, addressLines: s.address_lines, uid: s.uid };
}

/** The row as tools return it: the snapshot columns folded into `customer`. */
function withCustomerSnapshot<T extends LocalInvoiceRow | LocalCreditNoteRow>(row: T) {
  const {
    customer_name: _n, customer_address_lines: _a, customer_country: _c, customer_uid: _u,
    customer_revision: _r, customer_snapshot_source: _s, ...rest
  } = row;
  return { ...rest, customer: snapshotFromRow(row) };
}

export interface LocalInvoiceRow {
  id: string;
  number: string;
  customer_id: string;
  status: "issued" | "partially_credited" | "credited";
  currency: string;
  net_total: number;
  vat_total: number;
  gross_total: number;
  credited_total: number;
  tax_mode: TaxMode;
  payment_term_days: number;
  service_period_from: string;
  service_period_to: string;
  issued_at: string;
  due_date: string;
  memo: string | null;
  template_id: string;
  template_version: string;
  template_fingerprint: string;
  archive_path: string;
  archive_sha256: string;
  customer_name: string;
  customer_address_lines: string; // JSON-encoded string[]
  customer_country: string;
  customer_uid: string | null;
  customer_revision: number;
  customer_snapshot_source: CustomerSnapshotSource;
  quote_id: string | null;
  quote_revision: number | null;
  ticket_id: string | null;
}

export interface LocalCreditNoteRow {
  id: string;
  number: string;
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  currency: string;
  net_total: number;
  vat_total: number;
  gross_total: number;
  reason: string;
  service_period_from: string;
  service_period_to: string;
  issued_at: string;
  template_id: string;
  template_version: string;
  template_fingerprint: string;
  archive_path: string;
  archive_sha256: string;
  customer_name: string;
  customer_address_lines: string; // JSON-encoded string[]
  customer_country: string;
  customer_uid: string | null;
  customer_revision: number;
  customer_snapshot_source: CustomerSnapshotSource;
  ticket_id: string | null;
}

function validateNumber(value: unknown, what: "invoice" | "credit note"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("number is required (it comes with the request — this connector does not auto-number in live mode).");
  // The number names the archived PDF: same file-name rule as quotes, checked
  // before any reservation or archive write (see document-number.ts).
  return requireSafeDocumentNumber(value, what);
}

function validateServicePeriod(value: unknown): { from: string; to: string } {
  const p = (value ?? {}) as Record<string, unknown>;
  if (typeof p.from !== "string" || Number.isNaN(new Date(p.from).getTime())) throw new Error("service_period.from must be an ISO date");
  if (typeof p.to !== "string" || Number.isNaN(new Date(p.to).getTime())) throw new Error("service_period.to must be an ISO date");
  return { from: p.from, to: p.to };
}

/**
 * Line VAT must agree with the tax mode the connector derived. Reverse charge
 * (the customer owes the VAT) and the small-business exemption mean no VAT on
 * any line; an invoice saying "reverse charge" AND charging 20 % is legally
 * wrong — and was issued with every check passing (Rehearsal demo, 2026-10-19).
 * Normal mode stays open: 0 % lines can be legitimately exempt.
 */
export function refuseIfVatContradictsTaxMode(lines: Array<{ vat_rate: number }>, taxMode: TaxMode, what: string): void {
  if (taxMode === "normal") return;
  const bad = lines.map((l, i) => ({ i, rate: l.vat_rate })).filter((x) => x.rate !== 0);
  if (bad.length === 0) return;
  const why = taxMode === "reverse_charge"
    ? "the customer is in another EU country and has a VAT ID, so the tax liability passes to them (reverse charge)"
    : "the company is a small business exempt from VAT (Kleinunternehmer)";
  throw new Error(
    `Refused: ${what} lines must have vat_rate 0 — ${why}. ` +
      `Lines with VAT: ${bad.map((b) => `lines[${b.i}] ${b.rate}%`).join(", ")}. Nothing was issued.`
  );
}

async function requireNumberUnused(db: Db, number: string): Promise<void> {
  const row = await db.get<{ n: number }>("SELECT COUNT(*) as n FROM local_numbers WHERE number = ?", [number]);
  if ((row?.n ?? 0) > 0) throw new Error(`Refused: number ${JSON.stringify(number)} has already been used (invoice or credit note). Nothing was issued.`);
}

export function representativeVatRate(lines: PricedInvoiceLine[], netTotal: number, vatTotal: number): number {
  if (lines.length > 0) return lines[0].vat_rate;
  return netTotal > 0 ? roundToCents((vatTotal / netTotal) * 100) : 0;
}

/**
 * One document line row. The catalogue columns (item_id, list_price,
 * item_revision) come from lines.ts resolveLocalLines — null for a line without item_id.
 */
async function insertLine(
  db: Db, table: "local_invoice_lines" | "local_credit_note_lines", fk: "invoice_id" | "credit_note_id",
  docId: string, line: PricedInvoiceLine, input: LocalLine | undefined
): Promise<void> {
  await db.run(
    `INSERT INTO ${table} (id, ${fk}, description, qty, unit, unit_price, vat_rate, line_net, line_vat, line_gross,
       item_id, list_price, item_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), docId, line.description, line.qty, input?.unit ?? "Stk.", line.unit_price, line.vat_rate,
      line.line_net, line.line_vat, line.line_gross, input?.item_id ?? null, input?.list_price ?? null,
      input?.item_revision ?? null,
    ]
  );
}

function lineForTemplate(l: PricedInvoiceLine, unit: string): LineForTemplate {
  return { ...l, unit };
}

interface PreparedInvoice {
  /** Read in the same call that derives the tax mode; the only customer data rendered or stored. */
  customer: CustomerSnapshot;
  customerId: string;
  number: string;
  documentDate: string;
  servicePeriod: { from: string; to: string };
  linesWithUnit: LocalLine[];
  totals: ReturnType<typeof computeLineTotals>;
  taxMode: TaxMode;
  paymentTermDays: number;
}

/**
 * Optional `customer_revision` on create_invoice / preview_invoice (§3.6): the
 * approval names the customer revision it saw; a tax-data change between
 * approval and execution then refuses instead of issuing to data nobody
 * approved. Same wording as every revision refusal (R11).
 */
function requireCustomerRevision(customer: CustomerRowWithRevision, declared: unknown): void {
  if (declared === undefined || declared === null) return;
  const current = customer.revision ?? 1;
  if (declared !== current) {
    throw new Error(
      `Refused: Customer ${customer.id} is at revision ${current}; this request is for revision ${JSON.stringify(declared)}. Nothing was issued.`
    );
  }
}

async function prepareInvoice(db: Db, args: Record<string, any>, ctx: LocalCtx): Promise<PreparedInvoice> {
  const { customer_id, net_total, currency, lines } = args;

  const customerRow: CustomerRowWithRevision = await requireLocalCustomer(db, customer_id);
  requireCustomerRevision(customerRow, args.customer_revision);
  const customer = snapshotFromCustomer(customerRow);
  const number = validateNumber(args.number, "invoice");
  // Format-only here — both create_invoice and preview_invoice call this;
  // the "must be today" refusal is create_invoice's own, below (see date.ts).
  const documentDate = validateDocumentDate(args.document_date);
  const servicePeriod = validateServicePeriod(args.service_period);
  const linesWithUnit = await resolveLocalLines(db, lines);
  const totals = computeLineTotals(linesWithUnit);

  if (currency !== HOME_CURRENCY) refuse("currency", currency, HOME_CURRENCY, "Local live invoicing issues in EUR only.");
  if (!valuesMatch(net_total, totals.net_total, INVOICE_VALUE_TOLERANCE)) {
    refuse("net_total", net_total, totals.net_total, "Recomputed as sum(qty × unit_price), in cents, from the invoice lines.");
  }

  const taxMode = deriveTaxMode({
    vatMode: ctx.company.vat_mode,
    homeCountryCode: ctx.company.address.country_code,
    customerCountryCode: customer.country,
    customerUid: customer.uid,
  });
  refuseIfInvalidTaxMode(
    {
      vatMode: ctx.company.vat_mode,
      homeCountryCode: ctx.company.address.country_code,
      customerCountryCode: customer.country,
      customerUid: customer.uid,
    },
    totals.gross_total
  );
  refuseIfVatContradictsTaxMode(linesWithUnit, taxMode, "invoice");

  const paymentTermDays =
    args.payment_term_days === undefined || args.payment_term_days === null
      ? ctx.company.default_payment_term_days
      : (() => {
          if (!Number.isInteger(args.payment_term_days) || args.payment_term_days <= 0) {
            throw new Error(`payment_term_days must be a positive integer, got ${JSON.stringify(args.payment_term_days)}`);
          }
          return args.payment_term_days as number;
        })();

  return { customer, customerId: customerRow.id, number, documentDate, servicePeriod, linesWithUnit, totals, taxMode, paymentTermDays };
}

function invoiceVars(ctx: LocalCtx, prepared: PreparedInvoice, issuedAt: Date, dueDate: Date) {
  const { customer, number, servicePeriod, linesWithUnit, totals, taxMode, paymentTermDays } = prepared;
  const linesForTemplate = totals.lines.map((l, i) => lineForTemplate(l, linesWithUnit[i].unit));
  return buildViewModel({
    company: ctx.company,
    customer: viewModelCustomer(customer),
    documentKind: "invoice",
    number,
    issuedAt,
    servicePeriod,
    lines: linesForTemplate,
    netTotal: totals.net_total,
    vatTotal: totals.vat_total,
    grossTotal: totals.gross_total,
    taxMode,
    vatRate: representativeVatRate(totals.lines, totals.net_total, totals.vat_total),
    invoiceOnly: { paymentTermDays, dueDate },
  });
}

async function invoiceWithLines(db: Db, idOrNumber: string) {
  const invoice = await requireLocalInvoiceRow(db, idOrNumber);
  const lines = await db.all<any>("SELECT * FROM local_invoice_lines WHERE invoice_id = ? ORDER BY rowid", [invoice.id]);
  return { ...withCustomerSnapshot(invoice), lines };
}

export async function requireLocalInvoiceRow(db: Db, idOrNumber: string): Promise<LocalInvoiceRow> {
  const byId = await db.get<LocalInvoiceRow>("SELECT * FROM local_invoices WHERE id = ?", [idOrNumber]);
  if (byId) return byId;
  const byNumber = await db.get<LocalInvoiceRow>("SELECT * FROM local_invoices WHERE number = ?", [idOrNumber]);
  if (byNumber) return byNumber;
  throw new Error(`Unknown invoice id: ${idOrNumber}`);
}

export async function create_invoice(db: Db, args: Record<string, any>, ctx: LocalCtx) {
  requireDocumentSupported(ctx.template, "invoice");
  const conversion = await prepareQuoteConversion(db, args);
  args = conversion?.args ?? args;
  const prepared = await prepareInvoice(db, args, ctx);
  // Issuing — unlike preview_invoice — refuses a document_date that is not
  // today in the company's own calendar (see date.ts): the printed date is
  // the date on the request, never "now", and it must be today or the
  // approved preview and the issued document could date-drift apart.
  requireDocumentDateIsToday(prepared.documentDate, ctx.company.timezone);
  await requireNumberUnused(db, prepared.number);
  // D1 (Andreas, 2026-10-21): reverse charge only with a stored VIES `valid`.
  if (prepared.taxMode === "reverse_charge") await requireViesValidForReverseCharge(db, prepared.customerId, "invoice");

  // Fixed, non-"now" issue instant — the document's own date at UTC midnight
  // — so re-rendering the same request (preview, then issue) is deterministic
  // (see pdf-render.ts).
  const issuedAt = documentDateToUTCDate(prepared.documentDate);
  const dueDate = new Date(issuedAt.getTime() + prepared.paymentTermDays * 24 * 60 * 60 * 1000);
  const vars = invoiceVars(ctx, prepared, issuedAt, dueDate);

  const buffer = await renderInvoiceDocument(ctx.template, vars, issuedAt);
  const templateFingerprint = canonicalSha256(ctx.template);

  // Write-once archive BEFORE any database row — see module docstring.
  const path = archivePath(ctx.dataDir, issuedAt.getFullYear(), prepared.number);
  const archived = writeOnce(path, buffer);

  const id = uuidv4();
  await db.run("BEGIN");
  try {
    await db.run(`INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES (?, 'invoice', ?, ?)`, [
      prepared.number, id, issuedAt.toISOString(),
    ]);
    await db.run(
      `INSERT INTO local_invoices (
        id, number, customer_id, status, currency, net_total, vat_total, gross_total, credited_total, tax_mode,
        payment_term_days, service_period_from, service_period_to, issued_at, due_date, memo,
        template_id, template_version, template_fingerprint, archive_path, archive_sha256, ticket_id,
        ${SNAPSHOT_COLUMNS}, quote_id, quote_revision
      ) VALUES (?, ?, ?, 'issued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, prepared.number, prepared.customerId, HOME_CURRENCY, prepared.totals.net_total, prepared.totals.vat_total,
        prepared.totals.gross_total, prepared.taxMode, prepared.paymentTermDays, prepared.servicePeriod.from,
        prepared.servicePeriod.to, issuedAt.toISOString(), dueDate.toISOString(), args.memo ?? null,
        ctx.template.template, ctx.template.version, templateFingerprint, archived.path, archived.sha256,
        args.ticket_id ?? null, ...snapshotParams(prepared.customer),
        conversion?.quoteId ?? null, conversion?.quoteRevision ?? null,
      ]
    );
    for (let i = 0; i < prepared.totals.lines.length; i++) {
      await insertLine(db, "local_invoice_lines", "invoice_id", id, prepared.totals.lines[i], prepared.linesWithUnit[i]);
    }
    if (conversion) await markQuoteConverted(db, conversion, id);
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }

  return invoiceWithLines(db, id);
}

export async function preview_invoice(db: Db, args: Record<string, any>, ctx: LocalCtx) {
  requireDocumentSupported(ctx.template, "invoice");
  const conversion = await prepareQuoteConversion(db, args);
  args = conversion?.args ?? args;
  const prepared = await prepareInvoice(db, args, ctx);
  // Deliberately no requireNumberUnused — a preview does not consume the number.
  // Deliberately no requireDocumentDateIsToday — an approver may want to see
  // the PDF as it would print for any date; only create_invoice enforces it.

  const issuedAt = documentDateToUTCDate(prepared.documentDate);
  const dueDate = new Date(issuedAt.getTime() + prepared.paymentTermDays * 24 * 60 * 60 * 1000);
  const vars = invoiceVars(ctx, prepared, issuedAt, dueDate);

  const buffer = await renderInvoiceDocument(ctx.template, vars, issuedAt);
  return {
    filename: `invoice-${prepared.number}.pdf`,
    contentType: "application/pdf",
    contentBase64: buffer.toString("base64"),
    sha256: sha256Buffer(buffer),
    pages: approximatePageCount(buffer),
  };
}

export async function get_invoice(db: Db, args: Record<string, any>) {
  return invoiceWithLines(db, args.id);
}

export async function list_invoices(db: Db, args: Record<string, any>) {
  const { customer_id, status, limit = 50 } = args;
  const conditions: string[] = [];
  const params: any[] = [];
  if (customer_id) { conditions.push("customer_id = ?"); params.push(customer_id); }
  if (status) { conditions.push("status = ?"); params.push(status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rows = await db.all<LocalInvoiceRow>(`SELECT * FROM local_invoices ${where} ORDER BY issued_at DESC LIMIT ?`, params);
  return rows.map(withCustomerSnapshot);
}

// --- Quote → invoice (Part B: contract §4.4, AM2, R7, R8, D1) ---
//
// create_invoice / preview_invoice with `quote_id` + `quote_revision` (both or
// neither). Everything else is the normal invoice path: `number` and
// document_date == today are still required (R7), the tax mode comes from the
// customer's CURRENT data, and refuseIfInvalidTaxMode /
// refuseIfVatContradictsTaxMode apply unchanged (R8), and so does
// create_invoice's D1 guard (reverse charge only with a stored VIES `valid`). The quote is marked
// `converted` in the same transaction as the invoice insert.

interface QuoteConversion {
  /** The request with `lines` filled from the quote revision when omitted. */
  args: Record<string, any>;
  quoteId: string;
  quoteNumber: string;
  quoteRevision: number;
  customerId: string;
}

async function prepareQuoteConversion(db: Db, args: Record<string, any>): Promise<QuoteConversion | null> {
  const hasId = args.quote_id !== undefined && args.quote_id !== null;
  const hasRevision = args.quote_revision !== undefined && args.quote_revision !== null;
  if (!hasId && !hasRevision) return null;
  if (hasId !== hasRevision) {
    throw new Error("Refused: quote_id and quote_revision go together — pass both to invoice a quote, or neither. Nothing was issued.");
  }
  const quote = await requireLocalQuote(db, args.quote_id);
  if (quote.status === "converted") {
    const inv = await db.get<{ number: string }>("SELECT number FROM local_invoices WHERE id = ?", [quote.invoice_id]);
    throw new Error(`Refused: quote ${quote.number} was already invoiced (invoice ${inv?.number ?? quote.invoice_id}) — one invoice per quote. Nothing was issued.`);
  }
  if (quote.status !== "issued") throw new Error(`Refused: quote ${quote.number} is ${quote.status}. Nothing was issued.`);
  if (args.quote_revision !== quote.revision) {
    throw new Error(
      `Refused: Quote ${quote.number} is at revision ${quote.revision}; this request is for revision ${JSON.stringify(args.quote_revision)}. Nothing was issued.`
    );
  }
  if (args.customer_id !== quote.customer_id) {
    refuse("customer_id", args.customer_id, quote.customer_id, `Quote ${quote.number} is for customer ${quote.customer_id}. Nothing was issued.`);
  }
  const revision = await requireQuoteRevisionRow(db, quote, quote.revision);

  // AM2: the quote was made for one revision of the customer's data; a later
  // change (e.g. a new VAT ID that turns normal VAT into reverse charge) must
  // not flow into an invoice nobody quoted. Mirrors the R11 wording.
  const customer = (await requireLocalCustomer(db, quote.customer_id)) as LocalCustomer & { revision?: number };
  const customerRevision = customer.revision ?? 1;
  if (customerRevision !== revision.customer_revision) {
    throw new Error(
      `Refused: Customer ${customer.id} is at revision ${customerRevision}; quote ${quote.number} revision ${quote.revision} ` +
        `was made for customer revision ${revision.customer_revision} — update the quote first. Nothing was issued.`
    );
  }

  // Lines omitted → the quote revision's lines (partial invoicing passes its own).
  const lines = args.lines !== undefined ? args.lines : storedLinesAsInput(JSON.parse(revision.lines) as StoredQuoteLine[]);
  return {
    args: { ...args, lines },
    quoteId: quote.id,
    quoteNumber: quote.number,
    quoteRevision: quote.revision,
    customerId: quote.customer_id,
  };
}

/** Inside the invoice transaction: issued → converted, guarded against a concurrent conversion or update. */
async function markQuoteConverted(db: Db, conversion: QuoteConversion, invoiceId: string): Promise<void> {
  await db.run(
    `UPDATE local_quotes SET status = 'converted', invoice_id = ?, updated_at = ? WHERE id = ? AND status = 'issued' AND revision = ?`,
    [invoiceId, new Date().toISOString(), conversion.quoteId, conversion.quoteRevision]
  );
  const after = await db.get<{ invoice_id: string | null }>("SELECT invoice_id FROM local_quotes WHERE id = ?", [conversion.quoteId]);
  if (after?.invoice_id !== invoiceId) {
    throw new Error(`Refused: quote ${conversion.quoteNumber} changed during this call. Nothing was issued.`);
  }
}

// --- Credit notes ---

async function creditNoteWithLines(db: Db, id: string) {
  const row = await db.get<LocalCreditNoteRow>("SELECT * FROM local_credit_notes WHERE id = ?", [id]);
  if (!row) throw new Error(`Unknown credit note id: ${id}`);
  const lines = await db.all<any>("SELECT * FROM local_credit_note_lines WHERE credit_note_id = ? ORDER BY rowid", [id]);
  return { ...withCustomerSnapshot(row), lines };
}

export async function create_credit_note(db: Db, args: Record<string, any>, ctx: LocalCtx) {
  requireDocumentSupported(ctx.template, "credit_note");
  const { invoice_id, credit_total, currency, reason, lines } = args;

  if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  const number = validateNumber(args.number, "credit note");
  const documentDate = validateDocumentDate(args.document_date);
  requireDocumentDateIsToday(documentDate, ctx.company.timezone);
  await requireNumberUnused(db, number);

  const invoice = await requireLocalInvoiceRow(db, invoice_id);
  // A credit note corrects THAT invoice: it renders and stores the invoice's
  // snapshot, never the customer's current data (R1).
  const customer = snapshotFromRow(invoice);

  if (currency !== invoice.currency) refuse("currency", currency, invoice.currency, `Invoice ${invoice.number} is in ${invoice.currency}.`);

  let totals: ReturnType<typeof computeLineTotals>;
  let linesWithUnit: LocalLine[];
  if (lines !== undefined) {
    // A credit note corrects an issued invoice — an item deactivated since must not block it.
    linesWithUnit = await resolveLocalLines(db, lines, { allowInactive: true });
    totals = computeLineTotals(linesWithUnit);
    // A credit note shares the invoice's tax treatment — its lines too.
    refuseIfVatContradictsTaxMode(linesWithUnit, invoice.tax_mode as TaxMode, "credit note");
  } else {
    const remainingNet = roundToCents(invoice.net_total - invoice.credited_total);
    const effectiveVatRate = invoice.net_total > 0 ? invoice.vat_total / invoice.net_total : 0;
    const vat = roundToCents(remainingNet * effectiveVatRate);
    totals = { lines: [], net_total: remainingNet, vat_total: vat, gross_total: roundToCents(remainingNet + vat) };
    linesWithUnit = [];
  }

  if (!valuesMatch(credit_total, totals.net_total, INVOICE_VALUE_TOLERANCE)) {
    refuse("credit_total", credit_total, totals.net_total, "Recomputed as sum(qty × unit_price), in cents, from the credit lines.");
  }

  const projectedCredited = roundToCents(invoice.credited_total + totals.net_total);
  if (projectedCredited - invoice.net_total > INVOICE_VALUE_TOLERANCE) {
    throw new Error(
      `Refused: credit would exceed invoice ${invoice.number}'s net total — already credited ${invoice.credited_total}, this credit ${totals.net_total}, net total ${invoice.net_total}.`
    );
  }

  const servicePeriod = args.service_period ? validateServicePeriod(args.service_period) : { from: invoice.service_period_from, to: invoice.service_period_to };
  const issuedAt = documentDateToUTCDate(documentDate);
  const linesForTemplate = totals.lines.map((l, i) => lineForTemplate(l, linesWithUnit[i]?.unit ?? "Stk."));

  const vars = buildViewModel({
    company: ctx.company,
    customer: viewModelCustomer(customer),
    documentKind: "credit_note",
    number,
    issuedAt,
    servicePeriod,
    lines: linesForTemplate,
    netTotal: totals.net_total,
    vatTotal: totals.vat_total,
    grossTotal: totals.gross_total,
    taxMode: invoice.tax_mode, // a credit note shares the invoice it corrects' tax treatment
    vatRate: representativeVatRate(totals.lines, totals.net_total, totals.vat_total),
    creditNoteOnly: { invoiceNumber: invoice.number, invoiceIssuedAt: new Date(invoice.issued_at) },
  });

  const buffer = await renderInvoiceDocument(ctx.template, vars, issuedAt);
  const templateFingerprint = canonicalSha256(ctx.template);
  const path = archivePath(ctx.dataDir, issuedAt.getFullYear(), number);
  const archived = writeOnce(path, buffer);

  const id = uuidv4();
  await db.run("BEGIN");
  try {
    await db.run(`INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES (?, 'credit_note', ?, ?)`, [
      number, id, issuedAt.toISOString(),
    ]);
    await db.run(
      `INSERT INTO local_credit_notes (
        id, number, invoice_id, invoice_number, customer_id, currency, net_total, vat_total, gross_total, reason,
        service_period_from, service_period_to, issued_at, template_id, template_version, template_fingerprint,
        archive_path, archive_sha256, ticket_id, ${SNAPSHOT_COLUMNS}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, number, invoice.id, invoice.number, invoice.customer_id, currency, totals.net_total, totals.vat_total,
        totals.gross_total, reason, servicePeriod.from, servicePeriod.to, issuedAt.toISOString(), ctx.template.template,
        ctx.template.version, templateFingerprint, archived.path, archived.sha256, args.ticket_id ?? null,
        ...snapshotParams(customer),
      ]
    );
    for (let i = 0; i < totals.lines.length; i++) {
      await insertLine(db, "local_credit_note_lines", "credit_note_id", id, totals.lines[i], linesWithUnit[i]);
    }
    const newStatus = projectedCredited >= invoice.net_total - INVOICE_VALUE_TOLERANCE ? "credited" : "partially_credited";
    await db.run("UPDATE local_invoices SET credited_total = ?, status = ? WHERE id = ?", [projectedCredited, newStatus, invoice.id]);
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }

  return creditNoteWithLines(db, id);
}

export async function get_credit_note(db: Db, args: Record<string, any>) {
  return creditNoteWithLines(db, args.id);
}

export async function list_credit_notes(db: Db, args: Record<string, any>) {
  const { invoice_id, customer_id, limit = 50 } = args;
  const conditions: string[] = [];
  const params: any[] = [];
  if (invoice_id) { conditions.push("invoice_id = ?"); params.push(invoice_id); }
  if (customer_id) { conditions.push("customer_id = ?"); params.push(customer_id); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rows = await db.all<LocalCreditNoteRow>(`SELECT * FROM local_credit_notes ${where} ORDER BY issued_at DESC LIMIT ?`, params);
  return rows.map(withCustomerSnapshot);
}

// --- Documents (archive reads) ---

export async function get_document(db: Db, args: Record<string, any>) {
  const { kind, id } = args;
  let archivePathStored: string;
  let archiveSha256: string;
  if (kind === "invoice-pdf") {
    const row = await requireLocalInvoiceRow(db, id);
    archivePathStored = row.archive_path;
    archiveSha256 = row.archive_sha256;
  } else if (kind === "credit-note-pdf") {
    const row = await db.get<LocalCreditNoteRow>("SELECT * FROM local_credit_notes WHERE id = ? OR number = ?", [id, id]);
    if (!row) throw new Error(`Unknown credit note id: ${id}`);
    archivePathStored = row.archive_path;
    archiveSha256 = row.archive_sha256;
  } else if (kind === "quote-pdf") {
    return quoteDocument(db, id);
  } else {
    throw new Error(`Unknown document kind: ${JSON.stringify(kind)} — expected "invoice-pdf", "credit-note-pdf" or "quote-pdf".`);
  }

  const buf = readAndVerify(archivePathStored, archiveSha256);
  return {
    filename: basename(archivePathStored),
    contentType: "application/pdf",
    contentBase64: buf.toString("base64"),
    sha256: archiveSha256,
  };
}

function approximatePageCount(buf: Buffer): number {
  const text = buf.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?!s)/g);
  return matches ? matches.length : 1;
}
