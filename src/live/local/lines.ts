/**
 * Document lines for the Local adapter (invoices, credit notes, quotes).
 *
 * Two entry points (docs/local-production-contract.md §5.3):
 *
 * - `validateLocalLines(lines)` — synchronous shape check, unchanged contract
 *   from A1. It cannot look anything up, so it refuses a line that carries
 *   `item_id` (fail-visible: a catalogue link must never be dropped or stored
 *   without the list price it points at).
 * - `resolveLocalLines(db, lines)` — the same shape check, plus the catalogue
 *   link: a line with `item_id` must name an existing, active item; the line
 *   then carries that item's `list_price` and `revision` at this moment.
 *   Description, unit_price and vat_rate stay exactly as given — the item
 *   never fills or overrides them, and a deviation from the item is not
 *   refused (the governing layer shows it).
 *
 * Lines without `item_id` come back from both with item_id / list_price /
 * item_revision = null.
 */
import type { InvoiceLineInput } from "../../money.js";
import type { Db } from "../../db.js";
import { requireActiveItemForLine } from "./tools/items.js";

export interface LocalLine extends InvoiceLineInput {
  unit: string;
  item_id: string | null;
  list_price: number | null;
  item_revision: number | null;
}

/** Shape check shared by both entry points; returns the raw item_id per line. */
function parseLines(lines: unknown): Array<{ line: LocalLine; itemId: string | null }> {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("lines must be a non-empty array of { description, qty, unit_price, vat_rate, unit?, item_id? }");
  }
  return lines.map((line, i) => {
    const { description, qty, unit_price, vat_rate, unit, item_id } = (line ?? {}) as Record<string, any>;
    if (typeof description !== "string" || !description.trim()) throw new Error(`lines[${i}].description is required`);
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) throw new Error(`lines[${i}].qty must be a positive number`);
    if (typeof unit_price !== "number" || !Number.isFinite(unit_price) || unit_price < 0) throw new Error(`lines[${i}].unit_price must be a number >= 0`);
    if (typeof vat_rate !== "number" || !Number.isFinite(vat_rate) || vat_rate < 0 || vat_rate > 100) throw new Error(`lines[${i}].vat_rate must be a number between 0 and 100`);
    if (unit !== undefined && typeof unit !== "string") throw new Error(`lines[${i}].unit must be a string`);
    if (item_id !== undefined && item_id !== null && (typeof item_id !== "string" || !item_id.trim())) {
      throw new Error(`lines[${i}].item_id must be a non-empty string`);
    }
    return {
      line: { item_id: null, description, qty, unit_price, vat_rate, unit: unit ?? "Stk.", list_price: null, item_revision: null },
      itemId: typeof item_id === "string" ? item_id : null,
    };
  });
}

/**
 * Same shape as the simulation's lines, plus an optional `unit` (defaults to
 * "Stk."). Synchronous: refuses `item_id` — use resolveLocalLines for lines
 * that may link a catalogue item.
 */
export function validateLocalLines(lines: unknown): LocalLine[] {
  return parseLines(lines).map(({ line, itemId }, i) => {
    if (itemId !== null) {
      throw new Error(`lines[${i}].item_id needs the catalogue lookup — this call path does not resolve items (resolveLocalLines does).`);
    }
    return line;
  });
}

/**
 * Shape check + catalogue link for lines of a NEW document. A line with
 * `item_id` is refused when the item does not exist or is inactive; otherwise
 * it carries the item's current list_price and revision.
 */
export async function resolveLocalLines(db: Db, lines: unknown): Promise<LocalLine[]> {
  const parsed = parseLines(lines);
  const out: LocalLine[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const { line, itemId } = parsed[i];
    if (itemId === null) {
      out.push(line);
      continue;
    }
    const item = await requireActiveItemForLine(db, itemId, i);
    out.push({ ...line, item_id: item.id, list_price: item.list_price, item_revision: item.revision });
  }
  return out;
}
