/**
 * The fixed, small set of operations a declarative invoice template may use
 * against a variables tree (see VARIABLES.md): `{{dotted.path}}`
 * substitution, `|money`/`|date` filters, and `when` conditions
 * (`==`/`!=`/bare truthy). No code runs from a template — this module is the
 * entire interpreter; a template can only ever combine these primitives.
 */

/** Reads a dotted path (e.g. "firma.adresse.einzeilig") out of a nested object. Missing path -> undefined. */
export function get(vars: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, vars);
}

/** "€ 9.000,00" / "€ -1.500,00" — German thousands separator, comma decimal, sign after the symbol. */
export function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const [intPart, decPart] = abs.toFixed(2).split(".");
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `€ ${sign}${withSep},${decPart}`;
}

/** "17.10.2026" from an ISO date/datetime string or a Date. */
export function formatDate(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

const FILTERS: Record<string, (v: unknown) => string> = {
  money: (v) => formatMoney(v as number),
  date: (v) => formatDate(v),
};

/** Replaces every `{{path}}` or `{{path|filter}}` in `str` with its resolved, formatted value. */
export function substitute(str: string, vars: Record<string, unknown>): string {
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
    const [pathPart, filterPart] = expr.split("|").map((s) => s.trim());
    const value = get(vars, pathPart);
    if (filterPart) {
      const filter = FILTERS[filterPart];
      if (!filter) throw new Error(`Template: unknown filter "${filterPart}" in "{{${expr}}}"`);
      return value === undefined || value === null ? "" : filter(value);
    }
    return value === undefined || value === null ? "" : String(value);
  });
}

/**
 * Resolves a text reference: `keyTemplate` (e.g. "title.{{dokument.art}}")
 * is first substituted to a concrete key (e.g. "title.invoice"), looked up
 * in `texts`, then the result is substituted again (a text's own value may
 * itself contain variables, e.g. "USt {{steuer.satz}} %").
 */
export function resolveText(keyTemplate: string, vars: Record<string, unknown>, texts: Record<string, string>): string {
  const key = substitute(keyTemplate, vars);
  const raw = texts[key];
  if (raw === undefined) throw new Error(`Template: unknown text key "${key}" (from "${keyTemplate}")`);
  return substitute(raw, vars);
}

/** `kunde.uid` (bare truthy) / `dokument.art == 'credit_note'` / `steuer.art != 'normal'`. */
export function evalWhen(expr: string, vars: Record<string, unknown>): boolean {
  const m = expr.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (m) {
    const [, leftPath, op, rightRaw] = m;
    const leftVal = get(vars, leftPath.trim());
    const right = rightRaw.trim().replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
    const eq = String(leftVal) === right;
    return op === "==" ? eq : !eq;
  }
  return Boolean(get(vars, expr.trim()));
}
