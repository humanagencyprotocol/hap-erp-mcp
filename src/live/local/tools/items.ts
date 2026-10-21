/**
 * Local catalogue items (Part C, docs/local-production-contract.md §5).
 *
 * Field names follow the simulator's `Item` (`list_price`, `sku`, `unit`,
 * `currency`, `vat_rate`, `stock`) so list_items / get_item answer the same
 * shape in both modes; `stock` is always null here (no inventory).
 *
 * Revision rule (R11): create → revision 1; every successful change → the
 * next revision; change tools name the revision they change and are refused
 * on mismatch; every revision's content is kept in local_master_revisions
 * (entity 'item') with the call's ticket_id, so get_item {id, revision}
 * returns old content. The price and VAT rate change only through
 * update_item_price — its own decision, separate from update_item.
 *
 * Issued documents never read the item again: a line stores the item's
 * list_price and revision at issue (lines.ts), so a later price change
 * cannot alter an issued invoice, credit note or quote.
 */
import { v4 as uuidv4 } from "uuid";
import type { Db } from "../../../db.js";
import type { LocalToolHandler } from "../dispatch.js";

export const ITEM_KINDS = ["service", "product"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

interface LocalItemRow {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  kind: ItemKind;
  unit: string;
  list_price: number;
  currency: string;
  vat_rate: number;
  active: number;
  revision: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface LocalItem {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  kind: ItemKind;
  unit: string;
  list_price: number;
  currency: string;
  vat_rate: number;
  active: boolean;
  revision: number;
  stock: null;
  created_at: string | null;
  updated_at: string | null;
}

/** The fields a revision snapshot keeps (everything a change can touch). */
type ItemContent = Pick<LocalItem, "sku" | "name" | "description" | "kind" | "unit" | "list_price" | "currency" | "vat_rate" | "active">;

function toItem(row: LocalItemRow): LocalItem {
  return {
    id: row.id, sku: row.sku, name: row.name, description: row.description, kind: row.kind, unit: row.unit,
    list_price: row.list_price, currency: row.currency, vat_rate: row.vat_rate, active: row.active === 1,
    revision: row.revision, stock: null, created_at: row.created_at, updated_at: row.updated_at,
  };
}

function contentOf(item: LocalItem): ItemContent {
  return {
    sku: item.sku, name: item.name, description: item.description, kind: item.kind, unit: item.unit,
    list_price: item.list_price, currency: item.currency, vat_rate: item.vat_rate, active: item.active,
  };
}

async function findItemRow(db: Db, id: unknown): Promise<LocalItemRow | undefined> {
  if (typeof id !== "string" || !id.trim()) return undefined;
  return db.get<LocalItemRow>("SELECT * FROM local_items WHERE id = ?", [id]);
}

async function requireItemRow(db: Db, id: unknown): Promise<LocalItemRow> {
  const row = await findItemRow(db, id);
  if (!row) throw new Error(`Unknown item id: ${String(id)}`);
  return row;
}

function itemLabel(item: { sku: string | null; name: string }): string {
  return item.sku ?? item.name;
}

/**
 * For lines.ts: the item a document line links to — must exist, and be
 * active unless `allowInactive` (credit notes correct an issued invoice, so
 * deactivation must not block them). New invoices and quotes refuse an
 * inactive item (contract §5.2).
 */
export async function requireItemForLine(
  db: Db, id: string, index: number, options: { allowInactive: boolean }
): Promise<LocalItem> {
  const row = await findItemRow(db, id);
  if (!row) throw new Error(`Refused: lines[${index}].item_id: unknown item ${id}.`);
  if (row.active !== 1 && !options.allowInactive) {
    throw new Error(`Refused: lines[${index}]: Item ${itemLabel(row)} is inactive — it cannot go on a new document.`);
  }
  return toItem(row);
}

// --- field validation (shared by create / update / update_item_price) ---

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Refused: ${field} must be a non-empty string. Nothing was saved.`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Refused: ${field} must be a string or null. Nothing was saved.`);
  return value.trim() === "" ? null : value.trim();
}

function requireKind(value: unknown): ItemKind {
  if (!ITEM_KINDS.includes(value as ItemKind)) {
    throw new Error(`Refused: kind must be one of ${ITEM_KINDS.join(", ")}. Nothing was saved.`);
  }
  return value as ItemKind;
}

function requireListPrice(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Refused: list_price must be a finite number >= 0. Nothing was saved.`);
  }
  return value;
}

function requireVatRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Refused: vat_rate must be a number between 0 and 100. Nothing was saved.`);
  }
  return value;
}

async function refuseDuplicateSku(db: Db, sku: string | null, selfId: string | null): Promise<void> {
  if (sku === null) return;
  const other = await db.get<{ id: string }>("SELECT id FROM local_items WHERE sku = ? AND id IS NOT ?", [sku, selfId]);
  if (other) throw new Error(`Refused: item ${other.id} already has item number ${sku}. Nothing was saved.`);
}

function requireRevision(row: LocalItemRow, declared: unknown): void {
  if (declared !== row.revision) {
    throw new Error(
      `Refused: Item ${row.id} is at revision ${row.revision}; this request is for revision ${JSON.stringify(declared)}. Nothing was saved.`
    );
  }
}

// --- persistence ---

async function writeRevision(db: Db, item: LocalItem, ticketId: unknown, at: string): Promise<void> {
  await db.run(
    `INSERT INTO local_master_revisions (entity, entity_id, revision, content, ticket_id, created_at)
     VALUES ('item', ?, ?, ?, ?, ?)`,
    [item.id, item.revision, JSON.stringify(contentOf(item)), typeof ticketId === "string" ? ticketId : null, at]
  );
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

/** Writes `next` as the item's next revision (row + revision snapshot), inside one transaction. */
async function saveNextRevision(db: Db, current: LocalItemRow, next: ItemContent, ticketId: unknown): Promise<LocalItem> {
  const at = new Date().toISOString();
  const revision = current.revision + 1;
  await inTransaction(db, async () => {
    // Re-check inside the transaction: a concurrent change must not be overwritten.
    const fresh = await requireItemRow(db, current.id);
    requireRevision(fresh, current.revision);
    await db.run(
      `UPDATE local_items SET sku = ?, name = ?, description = ?, kind = ?, unit = ?, list_price = ?, currency = ?,
         vat_rate = ?, active = ?, revision = ?, updated_at = ? WHERE id = ?`,
      [next.sku, next.name, next.description, next.kind, next.unit, next.list_price, next.currency,
       next.vat_rate, next.active ? 1 : 0, revision, at, current.id]
    );
    await writeRevision(db, { ...toItem(current), ...next, revision, updated_at: at }, ticketId, at);
  });
  return toItem(await requireItemRow(db, current.id));
}

// --- tools ---

export async function list_items(db: Db, args: Record<string, any>): Promise<LocalItem[]> {
  const { query, active = true, limit = 50 } = args;
  const conditions: string[] = [];
  const params: any[] = [];
  if (query) {
    conditions.push("(sku LIKE ? OR name LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like);
  }
  if (typeof active !== "boolean") throw new Error("active must be true or false");
  conditions.push("active = ?");
  params.push(active ? 1 : 0);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rows = await db.all<LocalItemRow>(`SELECT * FROM local_items ${where} ORDER BY name, sku LIMIT ?`, params);
  return rows.map(toItem);
}

/** Inactive items are returned too — old documents point at them. `revision` returns that revision's content. */
export async function get_item(db: Db, args: Record<string, any>): Promise<LocalItem> {
  const row = await requireItemRow(db, args.id);
  const current = toItem(row);
  if (args.revision === undefined || args.revision === null || args.revision === current.revision) return current;
  const rev = await db.get<{ content: string; created_at: string }>(
    "SELECT content, created_at FROM local_master_revisions WHERE entity = 'item' AND entity_id = ? AND revision = ?",
    [row.id, args.revision]
  );
  if (!rev) throw new Error(`Item ${row.id} has no revision ${JSON.stringify(args.revision)} (current: ${current.revision}).`);
  const content = JSON.parse(rev.content) as ItemContent;
  return { ...current, ...content, revision: args.revision, updated_at: rev.created_at };
}

export async function create_item(db: Db, args: Record<string, any>): Promise<LocalItem> {
  const name = requireText(args.name, "name");
  const kind = requireKind(args.kind);
  const unit = requireText(args.unit, "unit");
  const list_price = requireListPrice(args.list_price);
  const vat_rate = requireVatRate(args.vat_rate);
  const sku = optionalText(args.sku, "sku");
  const description = optionalText(args.description, "description");
  await refuseDuplicateSku(db, sku, null);

  const id = uuidv4();
  const at = new Date().toISOString();
  await inTransaction(db, async () => {
    await refuseDuplicateSku(db, sku, null);
    await db.run(
      `INSERT INTO local_items (id, sku, name, description, kind, unit, list_price, currency, vat_rate, active, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, 1, 1, ?, ?)`,
      [id, sku, name, description, kind, unit, list_price, vat_rate, at, at]
    );
    await writeRevision(db, toItem(await requireItemRow(db, id)), args.ticket_id, at);
  });
  return toItem(await requireItemRow(db, id));
}

const UPDATE_ITEM_FIELDS = ["name", "sku", "unit", "kind", "description", "active"] as const;

export async function update_item(db: Db, args: Record<string, any>): Promise<LocalItem> {
  if (args.list_price !== undefined || args.vat_rate !== undefined) {
    throw new Error("Refused: price and VAT rate are their own decision — use update_item_price. Nothing was saved.");
  }
  const row = await requireItemRow(db, args.id);
  const present = UPDATE_ITEM_FIELDS.filter((f) => args[f] !== undefined);
  if (present.length === 0) {
    throw new Error(`Refused: name at least one of ${UPDATE_ITEM_FIELDS.join(", ")} to change. Nothing was saved.`);
  }
  const current = contentOf(toItem(row));
  const next: ItemContent = { ...current };
  if (args.name !== undefined) next.name = requireText(args.name, "name");
  if (args.unit !== undefined) next.unit = requireText(args.unit, "unit");
  if (args.kind !== undefined) next.kind = requireKind(args.kind);
  if (args.sku !== undefined) next.sku = optionalText(args.sku, "sku");
  if (args.description !== undefined) next.description = optionalText(args.description, "description");
  if (args.active !== undefined) {
    if (typeof args.active !== "boolean") throw new Error("Refused: active must be true or false. Nothing was saved.");
    next.active = args.active;
  }
  requireRevision(row, args.revision);
  if (UPDATE_ITEM_FIELDS.every((f) => next[f] === current[f])) {
    throw new Error(`Refused: item ${row.id} already has these values — nothing would change. Nothing was saved.`);
  }
  await refuseDuplicateSku(db, next.sku, row.id);
  return saveNextRevision(db, row, next, args.ticket_id);
}

export async function update_item_price(db: Db, args: Record<string, any>): Promise<LocalItem> {
  const row = await requireItemRow(db, args.id);
  if (args.list_price === undefined || args.vat_rate === undefined) {
    throw new Error("Refused: update_item_price needs both list_price and vat_rate. Nothing was saved.");
  }
  const list_price = requireListPrice(args.list_price);
  const vat_rate = requireVatRate(args.vat_rate);
  requireRevision(row, args.revision);
  if (list_price === row.list_price && vat_rate === row.vat_rate) {
    throw new Error(
      `Refused: item ${row.id} already has list price ${list_price} and VAT rate ${vat_rate} % — nothing would change. Nothing was saved.`
    );
  }
  return saveNextRevision(db, row, { ...contentOf(toItem(row)), list_price, vat_rate }, args.ticket_id);
}

/** Handlers keyed by tool name, merged by dispatch.ts. */
export const ITEM_TOOL_HANDLERS: Readonly<Record<string, LocalToolHandler>> = {
  list_items: (db, args) => list_items(db, args),
  get_item: (db, args) => get_item(db, args),
  create_item: (db, args) => create_item(db, args),
  update_item: (db, args) => update_item(db, args),
  update_item_price: (db, args) => update_item_price(db, args),
};
