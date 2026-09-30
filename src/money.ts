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

export function valuesMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= VALUE_TOLERANCE;
}

export class RefusalError extends Error {}

/** Refuse naming the field, the declared value, and the computed/expected value. */
export function refuse(field: string, declared: unknown, expected: unknown, extra?: string): never {
  const suffix = extra ? ` ${extra}` : "";
  throw new RefusalError(
    `Refused: ${field} mismatch — declared ${JSON.stringify(declared)}, expected ${JSON.stringify(expected)}.${suffix}`
  );
}
