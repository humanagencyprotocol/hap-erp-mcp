/**
 * The gateway enforces bounds (value_max, discount_max, ...) on the DECLARED
 * `value`/`discount_pct`/`currency` fields of a tool call — it never inspects
 * line items. That makes the declaration the security boundary: if the
 * connector executed a document whose real total didn't match what was
 * declared and bound-checked, the enforcement would be checking a number
 * that has nothing to do with what actually happened. Every change tool in
 * this connector must recompute the real total from the lines and refuse the
 * call outright when the declaration doesn't match — never merely proceed
 * with the "real" number instead.
 */

/** Tolerance for float rounding drift, in currency units. */
export const VALUE_TOLERANCE = 0.01;

/**
 * Tolerance for the invoice/credit-note declared-value checks (0.005, per the
 * invoicing contract — tighter than VALUE_TOLERANCE because these totals are
 * summed per line, in cents, rather than derived from a single document-level
 * discount calculation).
 */
export const INVOICE_VALUE_TOLERANCE = 0.005;

/** Austrian default VAT rate (%), used when an item carries no vat_rate of its own. */
export const DEFAULT_VAT_RATE = 20;

export function roundToCents(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PricedLine {
  qty: number;
  list_price: number;
}

/** Net document total = sum(qty × list_price) × (1 − discount_pct/100), rounded to cents. */
export function computeNetTotal(lines: PricedLine[], discountPct: number): number {
  const gross = lines.reduce((sum, l) => sum + l.qty * l.list_price, 0);
  return roundToCents(gross * (1 - discountPct / 100));
}

export function valuesMatch(a: number, b: number, tolerance: number = VALUE_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance;
}

export interface InvoiceLineInput {
  item_id?: string | null;
  description: string;
  qty: number;
  unit_price: number;
  /** Percent, e.g. 20 for 20%. */
  vat_rate: number;
}

export interface PricedInvoiceLine extends InvoiceLineInput {
  line_net: number;
  line_vat: number;
  line_gross: number;
}

export interface InvoiceTotals {
  lines: PricedInvoiceLine[];
  net_total: number;
  vat_total: number;
  gross_total: number;
}

/**
 * Prices a set of invoice/credit-note lines: each line's net (qty × unit_price),
 * VAT (net × vat_rate/100), and gross are rounded to cents individually, then
 * summed — the per-line rounding is "in cents" the way the invoicing contract
 * describes the recomputation, and keeps a multi-rate document's VAT total
 * exact instead of applying one blended rate to the whole document.
 */
export function computeLineTotals(lines: InvoiceLineInput[]): InvoiceTotals {
  let net = 0;
  let vat = 0;
  const priced = lines.map((l) => {
    const line_net = roundToCents(l.qty * l.unit_price);
    const line_vat = roundToCents(line_net * (l.vat_rate / 100));
    net += line_net;
    vat += line_vat;
    return { ...l, line_net, line_vat, line_gross: roundToCents(line_net + line_vat) };
  });
  net = roundToCents(net);
  vat = roundToCents(vat);
  return { lines: priced, net_total: net, vat_total: vat, gross_total: roundToCents(net + vat) };
}

export class RefusalError extends Error {}

/** Refuse naming the field, the declared value, and the computed/expected value. */
export function refuse(field: string, declared: unknown, expected: unknown, extra?: string): never {
  const suffix = extra ? ` ${extra}` : "";
  throw new RefusalError(
    `Refused: ${field} mismatch — declared ${JSON.stringify(declared)}, expected ${JSON.stringify(expected)}.${suffix}`
  );
}
