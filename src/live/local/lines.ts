/**
 * Document lines for the Local adapter (invoices and credit notes now;
 * quotes in Part B). Moved out of tools/invoices.ts unchanged
 * (docs/local-production-contract.md §9, A1).
 *
 * `item_id`, `list_price` and `item_revision` are the catalogue link the
 * line rows store (M-A4). They are always null until the catalogue
 * (Part C) fills them; invoices.ts writes whatever this module returns.
 */
import type { InvoiceLineInput } from "../../money.js";

export interface LocalLine extends InvoiceLineInput {
  unit: string;
  item_id: string | null;
  list_price: number | null;
  item_revision: number | null;
}

/** Same shape as the simulation's lines, plus an optional `unit` (defaults to "Stk."). */
export function validateLocalLines(lines: unknown): LocalLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("lines must be a non-empty array of { description, qty, unit_price, vat_rate, unit? }");
  }
  return lines.map((line, i) => {
    const { description, qty, unit_price, vat_rate, unit } = (line ?? {}) as Record<string, any>;
    if (typeof description !== "string" || !description.trim()) throw new Error(`lines[${i}].description is required`);
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) throw new Error(`lines[${i}].qty must be a positive number`);
    if (typeof unit_price !== "number" || !Number.isFinite(unit_price) || unit_price < 0) throw new Error(`lines[${i}].unit_price must be a number >= 0`);
    if (typeof vat_rate !== "number" || !Number.isFinite(vat_rate) || vat_rate < 0 || vat_rate > 100) throw new Error(`lines[${i}].vat_rate must be a number between 0 and 100`);
    if (unit !== undefined && typeof unit !== "string") throw new Error(`lines[${i}].unit must be a string`);
    return { item_id: null, description, qty, unit_price, vat_rate, unit: unit ?? "Stk.", list_price: null, item_revision: null };
  });
}
