/**
 * Local customers (docs/local-production-contract.md §3).
 *
 * Writes (each its own decision for the governing layer):
 *   create_customer           a new customer, revision 1
 *   update_customer           contact data only: email, CRM link
 *   update_customer_tax_data  tax data: name, address, country, VAT ID — full replacement
 * Reads: find_customers, get_customer {id, revision?}.
 * Card-only reads (never listed to the AI by the governing layer): check_vat_id,
 * preview_customer_change.
 *
 * Every change makes the next revision; each revision's content is kept in
 * local_master_revisions as {name, address_lines, country, uid, email,
 * crm_contact_id}. A VAT ID of an EU state / XI is checked against VIES
 * (vies.ts) at EXECUTION, before the transaction; that result is what is
 * stored — whatever the card showed. `invalid` refuses; `not_checked` saves.
 *
 * The CLI (`erp-mcp customers add|import`, cli.ts) also writes revision 1, but
 * never runs VIES: the person typing it is the decision; the stored VIES
 * status stays null = never checked.
 */
import { randomUUID } from "crypto";
import type { Db } from "../../../db.js";
import type { LocalCtx } from "./invoices.js";
import { deriveTaxMode, type TaxMode } from "../tax.js";
import { checkVatIdFormat, isViesCountry, normaliseVatId, refuseIfBadVatIdFormat, type VatIdFormat } from "../vat-id.js";
import {
  notApplicable, notChecked, viesClientFromEnv, PREVIEW_VIES_TIMEOUT_MS, type ViesClient, type ViesResult,
} from "../vies.js";

/** LocalCtx plus the VIES client (dispatch passes one built from env; tests inject a stub). */
export type CustomerCtx = LocalCtx & { vies?: ViesClient; now?: () => Date };

export interface LocalCustomer {
  id: string;
  name: string;
  address_lines: string; // JSON-encoded string[] in storage
  country: string;
  uid: string | null;
  email: string | null;
  crm_contact_id: string | null;
  revision: number;
  vies_status: ViesResult["status"] | null;
  vies_reason: string | null;
  vies_checked_at: string | null;
  vies_request_id: string | null;
  vies_name: string | null;
  vies_address: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface LocalCustomerView {
  id: string;
  name: string;
  address_lines: string[];
  country: string;
  uid: string | null;
  email: string | null;
  crm_contact_id: string | null;
  revision: number;
  vies: ViesResult | null;
  /** The stored VIES status, flat (null = never checked / no VAT ID) — for card checks. */
  vies_status: ViesResult["status"] | null;
  /**
   * Tax treatment a new invoice to this customer would get now — the same
   * deriveTaxMode create_invoice uses. Set whenever the tool runs with the
   * company file (every MCP call); absent only for CLI output.
   */
  tax_mode?: TaxMode;
  tax_mode_label?: string;
  created_at: string;
  updated_at: string | null;
}

/** Human-readable labels for tax-mode codes. */
export const TAX_MODE_LABELS: Readonly<Record<TaxMode, string>> = {
  normal: "Normal VAT",
  reverse_charge: "Reverse charge",
  kleinunternehmer: "Small-business exemption (Kleinunternehmer)",
};

function taxModeFor(ctx: LocalCtx, country: string, uid: string | null): TaxMode {
  return deriveTaxMode({
    vatMode: ctx.company.vat_mode, homeCountryCode: ctx.company.address.country_code,
    customerCountryCode: country, customerUid: uid,
  });
}

/** Adds tax_mode + label (when the company file is at hand). */
function withTaxMode(view: LocalCustomerView, ctx?: LocalCtx): LocalCustomerView {
  if (!ctx) return view;
  const tax_mode = taxModeFor(ctx, view.country, view.uid);
  return { ...view, tax_mode, tax_mode_label: TAX_MODE_LABELS[tax_mode] };
}

/** The content of one revision — exactly what local_master_revisions stores. */
export interface CustomerRevisionContent {
  name: string;
  address_lines: string[];
  country: string;
  uid: string | null;
  email: string | null;
  crm_contact_id: string | null;
}

function viesOf(row: LocalCustomer): ViesResult | null {
  if (!row.vies_status) return null;
  return {
    status: row.vies_status, reason: row.vies_reason, checked_at: row.vies_checked_at,
    request_id: row.vies_request_id, name: row.vies_name, address: row.vies_address,
  };
}

function toView(row: LocalCustomer): LocalCustomerView {
  return {
    id: row.id, name: row.name, address_lines: JSON.parse(row.address_lines), country: row.country, uid: row.uid,
    email: row.email, crm_contact_id: row.crm_contact_id ?? null, revision: row.revision ?? 1, vies: viesOf(row),
    vies_status: row.vies_status ?? null, created_at: row.created_at, updated_at: row.updated_at ?? null,
  };
}

function contentOf(row: LocalCustomer): CustomerRevisionContent {
  return {
    name: row.name, address_lines: JSON.parse(row.address_lines), country: row.country, uid: row.uid,
    email: row.email, crm_contact_id: row.crm_contact_id ?? null,
  };
}

async function writeRevision(
  db: Db, id: string, revision: number, content: CustomerRevisionContent, ticketId: string | null, at: string
): Promise<void> {
  await db.run(
    `INSERT INTO local_master_revisions (entity, entity_id, revision, content, ticket_id, created_at) VALUES ('customer', ?, ?, ?, ?, ?)`,
    [id, revision, JSON.stringify(content), ticketId, at]
  );
}

// --- Reads ---

export async function find_customers(db: Db, args: Record<string, any>, ctx?: LocalCtx): Promise<LocalCustomerView[]> {
  const { query, limit = 50 } = args;
  const conditions: string[] = [];
  const params: any[] = [];
  if (query) {
    conditions.push("(name LIKE ? OR email LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like);
  }
  if (typeof args.crm_contact_id === "string" && args.crm_contact_id) {
    conditions.push("crm_contact_id = ?");
    params.push(args.crm_contact_id);
  }
  if (typeof args.uid === "string" && args.uid) conditions.push("uid IS NOT NULL");
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  let rows = await db.all<LocalCustomer>(`SELECT * FROM local_customers ${where} ORDER BY name`, params);
  if (typeof args.uid === "string" && args.uid) {
    const uid = normaliseVatId(args.uid);
    rows = rows.filter((r) => r.uid !== null && normaliseVatId(r.uid) === uid);
  }
  return rows.slice(0, limit).map((r) => withTaxMode(toView(r), ctx));
}

export async function get_customer(db: Db, args: Record<string, any>, ctx?: LocalCtx): Promise<LocalCustomerView> {
  const row = await requireLocalCustomer(db, args.id);
  const wanted = args.revision;
  if (wanted === undefined || wanted === null || wanted === row.revision) return withTaxMode(toView(row), ctx);
  if (!Number.isInteger(wanted) || wanted < 1) throw new Error(`revision must be a positive integer, got ${JSON.stringify(wanted)}`);
  const rev = await db.get<{ content: string; created_at: string }>(
    `SELECT content, created_at FROM local_master_revisions WHERE entity = 'customer' AND entity_id = ? AND revision = ?`,
    [row.id, wanted]
  );
  if (!rev) throw new Error(`Customer ${row.id} has no revision ${wanted} (current: ${row.revision}).`);
  const content = JSON.parse(rev.content) as CustomerRevisionContent;
  // An old revision: content from its snapshot. The VIES result is only kept
  // for the current revision, so an old one carries none.
  return withTaxMode({
    id: row.id, ...content, crm_contact_id: content.crm_contact_id ?? null, email: content.email ?? null,
    revision: wanted, vies: null, vies_status: null, created_at: row.created_at, updated_at: rev.created_at,
  }, ctx);
}

export async function requireLocalCustomer(db: Db, id: string): Promise<LocalCustomer> {
  const row = await db.get<LocalCustomer>("SELECT * FROM local_customers WHERE id = ?", [id]);
  if (!row) throw new Error(`Unknown customer id: ${id}`);
  return row;
}

// --- Shared validation (CLI and tools) ---

export interface NewLocalCustomer {
  id?: string;
  name: string;
  address_lines: string[];
  country: string;
  uid?: string | null;
  email?: string | null;
  crm_contact_id?: string | null;
}

interface TaxShape { name: string; address_lines: string[]; country: string }

/** Shape rules for name / address / country — shared by the CLI and the write tools (§3.3 step 1). */
function validateTaxShape(c: Record<string, unknown>, at: string): TaxShape {
  if (typeof c.name !== "string" || !c.name.trim()) throw new Error(`${at}.name is required`);
  if (!Array.isArray(c.address_lines) || c.address_lines.length === 0 || !c.address_lines.every((l) => typeof l === "string" && l.trim())) {
    throw new Error(`${at}.address_lines must be a non-empty array of non-empty strings`);
  }
  if (typeof c.country !== "string" || !/^[A-Za-z]{2}$/.test(c.country)) throw new Error(`${at}.country must be a 2-letter ISO code, e.g. AT`);
  return { name: c.name, address_lines: c.address_lines as string[], country: c.country.toUpperCase() };
}

function optionalString(c: Record<string, unknown>, key: string, at: string): string | null {
  const v = c[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`${at}.${key} must be a string or null`);
  return v.trim() ? v : null;
}

function validateNewCustomer(raw: unknown, at: string): Required<Omit<NewLocalCustomer, "id">> & { id?: string } {
  const c = (raw ?? {}) as Record<string, unknown>;
  const shape = validateTaxShape(c, at);
  const uid = optionalString(c, "uid", at);
  return {
    id: typeof c.id === "string" ? c.id : undefined,
    ...shape,
    uid: uid === null ? null : normaliseVatId(uid),
    email: optionalString(c, "email", at),
    crm_contact_id: optionalString(c, "crm_contact_id", at),
  };
}

/** Tool refusals carry the contract's shape: "Refused: … Nothing was saved." */
function refused(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(msg.startsWith("Refused:") ? msg : `Refused: ${msg}. Nothing was saved.`);
}

async function uidOwner(db: Db, uid: string, exceptId?: string): Promise<string | null> {
  const rows = await db.all<{ id: string; uid: string }>(`SELECT id, uid FROM local_customers WHERE uid IS NOT NULL`);
  const hit = rows.find((r) => r.id !== exceptId && normaliseVatId(r.uid) === uid);
  return hit ? hit.id : null;
}

async function crmOwner(db: Db, crm: string, exceptId?: string): Promise<string | null> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM local_customers WHERE crm_contact_id = ? AND id != ?`, [crm, exceptId ?? ""]
  );
  return row ? row.id : null;
}

/** R10: one customer per VAT ID and per CRM contact. */
async function refuseDuplicates(db: Db, uid: string | null, crm: string | null, exceptId?: string): Promise<void> {
  if (uid) {
    const owner = await uidOwner(db, uid, exceptId);
    if (owner) throw new Error(`Refused: customer ${owner} already has VAT ID ${uid}. Nothing was saved.`);
  }
  if (crm) {
    const owner = await crmOwner(db, crm, exceptId);
    if (owner) throw new Error(`Refused: customer ${owner} already has CRM contact ${crm}. Nothing was saved.`);
  }
}

function refuseStaleRevision(row: LocalCustomer, declared: unknown): void {
  if (declared !== row.revision) {
    throw new Error(
      `Refused: Customer ${row.id} is at revision ${row.revision}; this request is for revision ${JSON.stringify(declared)}. Nothing was saved.`
    );
  }
}

function requireRevisionArg(args: Record<string, any>): number {
  if (!Number.isInteger(args.revision) || args.revision < 1) {
    throw refused(new Error(`revision is required — the revision of the customer this change is for (get_customer returns it)`));
  }
  return args.revision;
}

/** Format-check a VAT ID for a country (§3.3 step 2); null stays null. */
function storableUid(country: string, uid: unknown, at: string): string | null {
  if (uid === undefined || uid === null) return null;
  if (typeof uid !== "string" || !uid.trim()) throw refused(new Error(`${at}.uid must be a non-empty string or null`));
  const check = checkVatIdFormat(country, uid);
  refuseIfBadVatIdFormat(check, country);
  return check.uid;
}

// --- VIES ---

function viesClient(ctx: CustomerCtx): ViesClient {
  return ctx.vies ?? viesClientFromEnv(process.env);
}

/** One VIES query for an already format-checked VAT ID. Non-VIES countries → not_applicable, no call. */
async function runVies(ctx: CustomerCtx, country: string, uid: string, timeoutMs?: number): Promise<ViesResult> {
  if (!isViesCountry(country)) return notApplicable();
  const check = checkVatIdFormat(country, uid);
  if (check.format !== "ok") return notChecked("VAT ID format is wrong — not sent to VIES", ctx.now?.() ?? new Date());
  return viesClient(ctx).check({
    countryCode: check.prefix!, vatNumber: check.number!, requester: normaliseVatId(ctx.company.uid), timeoutMs,
  });
}

function refuseIfViesInvalid(uid: string, vies: ViesResult): void {
  if (vies.status === "invalid") {
    throw new Error(`Refused: VIES reports VAT ID ${uid} as not valid (checked ${vies.checked_at}). Nothing was saved.`);
  }
}

function viesParams(v: ViesResult | null): unknown[] {
  return v === null ? [null, null, null, null, null, null] : [v.status, v.reason, v.checked_at, v.request_id, v.name, v.address];
}

/**
 * Re-checks inside the write transaction what an await (the VIES call) could
 * have let change: the revision and the duplicates.
 */
async function recheckInTransaction(
  db: Db, id: string | null, revision: number | null, uid: string | null, crm: string | null
): Promise<void> {
  if (id !== null && revision !== null) {
    const row = await requireLocalCustomer(db, id);
    refuseStaleRevision(row, revision);
  }
  await refuseDuplicates(db, uid, crm, id ?? undefined);
}

async function inTransaction<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.run("BEGIN");
  try {
    const out = await fn();
    await db.run("COMMIT");
    return out;
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }
}

// --- Writes ---

export async function create_customer(db: Db, args: Record<string, any>, ctx: CustomerCtx): Promise<LocalCustomerView> {
  let c: ReturnType<typeof validateNewCustomer>;
  try {
    c = validateNewCustomer({ ...args, uid: undefined, id: undefined }, "customer");
  } catch (err) {
    throw refused(err);
  }
  const uid = storableUid(c.country, args.uid, "customer");
  await refuseDuplicates(db, uid, c.crm_contact_id);

  const vies = uid ? await runVies(ctx, c.country, uid) : null;
  if (uid && vies) refuseIfViesInvalid(uid, vies);

  const id = randomUUID();
  const at = (ctx.now?.() ?? new Date()).toISOString();
  const ticketId = typeof args.ticket_id === "string" ? args.ticket_id : null;
  await inTransaction(db, async () => {
    await recheckInTransaction(db, null, null, uid, c.crm_contact_id);
    await db.run(
      `INSERT INTO local_customers (id, name, address_lines, country, uid, email, crm_contact_id, revision, created_at, updated_at,
         vies_status, vies_reason, vies_checked_at, vies_request_id, vies_name, vies_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.name, JSON.stringify(c.address_lines), c.country, uid, c.email, c.crm_contact_id, at, at, ...viesParams(vies)]
    );
    await writeRevision(db, id, 1, {
      name: c.name, address_lines: c.address_lines, country: c.country, uid, email: c.email, crm_contact_id: c.crm_contact_id,
    }, ticketId, at);
  });
  return withTaxMode(toView(await requireLocalCustomer(db, id)), ctx);
}

const TAX_FIELDS = ["name", "address_lines", "country", "uid"] as const;

export async function update_customer(db: Db, args: Record<string, any>, ctx: CustomerCtx): Promise<LocalCustomerView> {
  if (TAX_FIELDS.some((f) => args[f] !== undefined)) {
    throw new Error("Refused: name/address/country/VAT ID are tax data — use update_customer_tax_data. Nothing was saved.");
  }
  const hasEmail = args.email !== undefined;
  const hasCrm = args.crm_contact_id !== undefined;
  if (!hasEmail && !hasCrm) throw refused(new Error("give at least one of email, crm_contact_id"));
  let email: string | null;
  let crm: string | null;
  try {
    email = optionalString(args, "email", "customer");
    crm = optionalString(args, "crm_contact_id", "customer");
  } catch (err) {
    throw refused(err);
  }
  const revision = requireRevisionArg(args);
  const row = await requireLocalCustomer(db, args.id);
  await refuseDuplicates(db, null, hasCrm ? crm : null, row.id);
  refuseStaleRevision(row, revision);

  const next: CustomerRevisionContent = {
    ...contentOf(row),
    ...(hasEmail ? { email } : {}),
    ...(hasCrm ? { crm_contact_id: crm } : {}),
  };
  if (next.email === row.email && next.crm_contact_id === (row.crm_contact_id ?? null)) {
    throw new Error(`Refused: nothing would change — customer ${row.id} already has this contact data. Nothing was saved.`);
  }

  const at = (ctx.now?.() ?? new Date()).toISOString();
  await inTransaction(db, async () => {
    await recheckInTransaction(db, row.id, revision, null, hasCrm ? crm : null);
    await db.run(
      `UPDATE local_customers SET email = ?, crm_contact_id = ?, revision = ?, updated_at = ? WHERE id = ?`,
      [next.email, next.crm_contact_id, revision + 1, at, row.id]
    );
    await writeRevision(db, row.id, revision + 1, next, typeof args.ticket_id === "string" ? args.ticket_id : null, at);
  });
  return withTaxMode(toView(await requireLocalCustomer(db, row.id)), ctx);
}

function sameTaxData(row: LocalCustomer, t: TaxShape & { uid: string | null }): boolean {
  return (
    row.name === t.name &&
    JSON.stringify(JSON.parse(row.address_lines)) === JSON.stringify(t.address_lines) &&
    row.country === t.country &&
    (row.uid === null ? null : normaliseVatId(row.uid)) === t.uid
  );
}

export async function update_customer_tax_data(db: Db, args: Record<string, any>, ctx: CustomerCtx): Promise<LocalCustomerView> {
  const missing = TAX_FIELDS.filter((f) => args[f] === undefined);
  if (missing.length > 0) {
    throw refused(new Error(`${missing.join(", ")} required — tax data is replaced as a whole (uid: null removes the VAT ID)`));
  }
  let shape: TaxShape;
  try {
    shape = validateTaxShape(args, "customer");
  } catch (err) {
    throw refused(err);
  }
  const uid = storableUid(shape.country, args.uid, "customer");
  const revision = requireRevisionArg(args);
  const row = await requireLocalCustomer(db, args.id);
  await refuseDuplicates(db, uid, null, row.id);
  refuseStaleRevision(row, revision);

  // A revision must mean a change — with one exception: the same EU VAT ID
  // whose last stored VIES result is not `valid` may be submitted unchanged,
  // to re-run the check (the only way to confirm it, which a reverse-charge
  // invoice needs — Andreas's decision D1).
  if (sameTaxData(row, { ...shape, uid })) {
    const recheck = uid !== null && isViesCountry(shape.country) && row.vies_status !== "valid";
    if (!recheck) {
      throw new Error(`Refused: nothing would change — customer ${row.id} already has this tax data. Nothing was saved.`);
    }
  }

  const vies = uid ? await runVies(ctx, shape.country, uid) : null;
  if (uid && vies) refuseIfViesInvalid(uid, vies);

  const at = (ctx.now?.() ?? new Date()).toISOString();
  const next: CustomerRevisionContent = { ...contentOf(row), ...shape, uid };
  await inTransaction(db, async () => {
    await recheckInTransaction(db, row.id, revision, uid, null);
    await db.run(
      `UPDATE local_customers SET name = ?, address_lines = ?, country = ?, uid = ?, revision = ?, updated_at = ?,
         vies_status = ?, vies_reason = ?, vies_checked_at = ?, vies_request_id = ?, vies_name = ?, vies_address = ?
       WHERE id = ?`,
      [shape.name, JSON.stringify(shape.address_lines), shape.country, uid, revision + 1, at, ...viesParams(vies), row.id]
    );
    await writeRevision(db, row.id, revision + 1, next, typeof args.ticket_id === "string" ? args.ticket_id : null, at);
  });
  return withTaxMode(toView(await requireLocalCustomer(db, row.id)), ctx);
}

// --- Card-only preview reads (§3.4) ---

export interface VatCheckResult {
  uid: string;
  format: VatIdFormat;
  vies: ViesResult;
  duplicate: boolean;
  duplicate_of: string | null;
}

async function vatCheck(db: Db, ctx: CustomerCtx, country: string, rawUid: string, exceptId?: string): Promise<VatCheckResult> {
  const check = checkVatIdFormat(country, rawUid);
  const vies =
    check.format === "ok"
      ? await runVies(ctx, country, check.uid, PREVIEW_VIES_TIMEOUT_MS)
      : check.format === "not_applicable"
        ? notApplicable()
        : notChecked("VAT ID format is wrong — not sent to VIES", ctx.now?.() ?? new Date());
  const owner = await uidOwner(db, check.uid, exceptId);
  return { uid: check.uid, format: check.format, vies, duplicate: owner !== null, duplicate_of: owner };
}

/** The card's VAT-ID line: format, VIES (≤ 4 s), duplicate. Display only — never stored. */
export async function check_vat_id(db: Db, args: Record<string, any>, ctx: CustomerCtx): Promise<VatCheckResult> {
  if (typeof args.country !== "string" || !/^[A-Za-z]{2}$/.test(args.country)) throw new Error("country must be a 2-letter ISO code, e.g. AT");
  if (typeof args.uid !== "string" || !args.uid.trim()) throw new Error("uid is required");
  return vatCheck(db, ctx, args.country.toUpperCase(), args.uid);
}

/** What update_customer_tax_data would change, for the card (R4: issued documents keep the old data). */
export async function preview_customer_change(db: Db, args: Record<string, any>, ctx: CustomerCtx) {
  const row = await requireLocalCustomer(db, args.id);
  const shape = validateTaxShape(args, "customer");
  // Absent uid = no VAT ID (the governing layer omits absent arguments).
  const uid = typeof args.uid === "string" && args.uid.trim() ? normaliseVatId(args.uid) : null;
  const current = {
    name: row.name, address_lines: JSON.parse(row.address_lines) as string[], country: row.country, uid: row.uid,
    revision: row.revision,
  };
  const changed: string[] = [];
  if (shape.name !== current.name) changed.push("name");
  if (JSON.stringify(shape.address_lines) !== JSON.stringify(current.address_lines)) changed.push("address_lines");
  if (shape.country !== current.country) changed.push("country");
  if (uid !== (current.uid === null ? null : normaliseVatId(current.uid))) changed.push("uid");

  const taxMode = (country: string, customerUid: string | null) => taxModeFor(ctx, country, customerUid);
  const now = taxMode(current.country, current.uid);
  const after = taxMode(shape.country, uid);

  const invoices = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM local_invoices WHERE customer_id = ?`, [row.id]);
  const creditNotes = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM local_credit_notes WHERE customer_id = ?`, [row.id]);
  const last = await db.get<{ number: string }>(
    `SELECT number FROM (
       SELECT number, issued_at FROM local_invoices WHERE customer_id = ?
       UNION ALL SELECT number, issued_at FROM local_credit_notes WHERE customer_id = ?
     ) ORDER BY issued_at DESC, number DESC LIMIT 1`,
    [row.id, row.id]
  );
  const openQuotes = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM local_quotes WHERE customer_id = ? AND status IN ('draft','sent')`, [row.id]
  );

  return {
    current,
    revision: row.revision,
    changed,
    uid_or_country_changed: changed.includes("uid") || changed.includes("country"),
    tax_mode: { now, after, now_label: TAX_MODE_LABELS[now], after_label: TAX_MODE_LABELS[after] },
    issued_documents: { invoices: invoices?.n ?? 0, credit_notes: creditNotes?.n ?? 0, last_number: last?.number ?? null },
    open_quotes: openQuotes?.n ?? 0,
    vat_check: uid ? await vatCheck(db, ctx, shape.country, uid, row.id) : null,
  };
}

// --- Issuing guard (Andreas's decision D1) ---

/**
 * A NEW reverse-charge invoice (incl. a quote → invoice conversion, which
 * goes through create_invoice) is issued only if the customer's last stored
 * VIES result is `valid`. Saving a customer as `not_checked` stays allowed;
 * issuing reverse charge to it does not. Credit notes are exempt: they
 * correct an issued invoice and follow that invoice's snapshot tax treatment,
 * so an unconfirmed VAT ID never blocks a correction (coordinator, 2026-10-21).
 */
export async function requireViesValidForReverseCharge(db: Db, customerId: string, what: string): Promise<void> {
  const row = await requireLocalCustomer(db, customerId);
  if (row.vies_status === "valid") return;
  const state = row.vies_status === null ? "never checked" : row.vies_status.replace("_", " ");
  throw new Error(
    `Refused: a reverse-charge ${what} needs the customer's VAT ID confirmed by VIES — confirm the VAT ID first ` +
      `(customer ${row.id}: ${state}${row.vies_reason ? `, ${row.vies_reason}` : ""}; update_customer_tax_data runs the check). ` +
      `Nothing was issued.`
  );
}

// --- CLI-only (not MCP tools) ---

async function insertCliCustomer(db: Db, id: string, c: ReturnType<typeof validateNewCustomer>, at: string): Promise<void> {
  await db.run(
    `INSERT INTO local_customers (id, name, address_lines, country, uid, email, crm_contact_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, c.name, JSON.stringify(c.address_lines), c.country, c.uid, c.email, c.crm_contact_id, at, at]
  );
  await writeRevision(db, id, 1, {
    name: c.name, address_lines: c.address_lines, country: c.country, uid: c.uid, email: c.email, crm_contact_id: c.crm_contact_id,
  }, null, at);
}

export async function addCustomer(db: Db, raw: unknown): Promise<LocalCustomerView> {
  const c = validateNewCustomer(raw, "customer");
  const id = c.id ?? randomUUID();
  const existing = await db.get<{ n: number }>("SELECT COUNT(*) as n FROM local_customers WHERE id = ?", [id]);
  if ((existing?.n ?? 0) > 0) throw new Error(`Refused: customer id ${id} already exists.`);
  await refuseDuplicates(db, c.uid, c.crm_contact_id);
  const at = new Date().toISOString();
  await inTransaction(db, () => insertCliCustomer(db, id, c, at));
  return toView(await requireLocalCustomer(db, id));
}

/** All-or-nothing: validates every entry, and checks every id against existing rows, before inserting any. */
export async function importCustomers(db: Db, rawList: unknown): Promise<LocalCustomerView[]> {
  if (!Array.isArray(rawList) || rawList.length === 0) throw new Error("customers import: input must be a non-empty JSON array");
  const parsed = rawList.map((raw, i) => validateNewCustomer(raw, `customers[${i}]`));

  const ids = parsed.map((c) => c.id ?? randomUUID());
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`customers import: id ${id} appears twice in the input — nothing was saved.`);
    seen.add(id);
  }
  for (const id of ids) {
    const existing = await db.get<{ n: number }>("SELECT COUNT(*) as n FROM local_customers WHERE id = ?", [id]);
    if ((existing?.n ?? 0) > 0) throw new Error(`Refused: customer id ${id} already exists — nothing in this import was saved.`);
  }
  for (const key of ["uid", "crm_contact_id"] as const) {
    const values = parsed.map((c) => c[key]).filter((v): v is string => v !== null);
    const dup = values.find((v, i) => values.indexOf(v) !== i);
    if (dup) throw new Error(`customers import: ${key} ${dup} appears twice in the input — nothing was saved.`);
  }
  for (const c of parsed) {
    try {
      await refuseDuplicates(db, c.uid, c.crm_contact_id);
    } catch (err) {
      throw new Error(`${(err as Error).message.replace(" Nothing was saved.", "")} — nothing in this import was saved.`);
    }
  }

  const at = new Date().toISOString();
  await inTransaction(db, async () => {
    for (let i = 0; i < parsed.length; i++) await insertCliCustomer(db, ids[i], parsed[i], at);
  });

  const out: LocalCustomerView[] = [];
  for (const id of ids) out.push(toView(await requireLocalCustomer(db, id)));
  return out;
}

export async function listCustomersForCli(db: Db): Promise<LocalCustomerView[]> {
  const rows = await db.all<LocalCustomer>("SELECT * FROM local_customers ORDER BY name");
  return rows.map(toView);
}

/** Handlers for dispatch.ts (customer area). */
export const CUSTOMER_TOOL_HANDLERS = {
  find_customers: (db: Db, args: Record<string, any>, ctx: LocalCtx) => find_customers(db, args, ctx),
  get_customer: (db: Db, args: Record<string, any>, ctx: LocalCtx) => get_customer(db, args, ctx),
  create_customer: (db: Db, args: Record<string, any>, ctx: LocalCtx) => create_customer(db, args, ctx),
  update_customer: (db: Db, args: Record<string, any>, ctx: LocalCtx) => update_customer(db, args, ctx),
  update_customer_tax_data: (db: Db, args: Record<string, any>, ctx: LocalCtx) => update_customer_tax_data(db, args, ctx),
  check_vat_id: (db: Db, args: Record<string, any>, ctx: LocalCtx) => check_vat_id(db, args, ctx),
  preview_customer_change: (db: Db, args: Record<string, any>, ctx: LocalCtx) => preview_customer_change(db, args, ctx),
} as const;
