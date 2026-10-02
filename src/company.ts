/**
 * Company file: the test data the simulated ERP starts from — the company's
 * items, prices, stock and customers, invented but realistic, prepared after the
 * first conversation. Loaded once into an empty database (ERP_COMPANY_FILE).
 *
 * Validated strictly and refused whole on the first problem: a half-loaded or
 * silently "fixed" company would make every later measurement of correctness
 * compare against data nobody wrote.
 */
import { readFileSync } from "fs";

export interface CompanyItem {
  id: string;
  sku: string;
  name: string;
  unit: string;
  list_price: number;
  stock: number;
}

export interface CompanyCustomer {
  id: string;
  name: string;
  email: string | null;
  country: string | null;
  credit_limit: number;
  open_balance: number;
  payment_terms: string | null;
}

export interface Company {
  name: string;
  currency: string;
  items: CompanyItem[];
  customers: CompanyCustomer[];
}

function fail(path: string, msg: string): never {
  throw new Error(`Company file ${path}: ${msg}`);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Shared item-row validation — used for the company file's `items[]` and the simulation package's `products[]`. */
function parseItemEntry(it: unknown, i: number, path: string, fieldName: string, skus: Set<string>): CompanyItem {
  const o = (it ?? {}) as Record<string, unknown>;
  const at = `${fieldName}[${i}]`;
  if (!str(o.sku)) fail(path, `${at}.sku is required`);
  if (skus.has(o.sku)) fail(path, `${at}.sku ${JSON.stringify(o.sku)} appears twice`);
  skus.add(o.sku);
  if (!str(o.name)) fail(path, `${at}.name is required`);
  if (!num(o.list_price) || o.list_price < 0) fail(path, `${at}.list_price must be a number >= 0`);
  if (!num(o.stock) || !Number.isInteger(o.stock) || o.stock < 0) fail(path, `${at}.stock must be a whole number >= 0`);
  return {
    id: str(o.id) ? o.id : `item-${i + 1}`,
    sku: o.sku,
    name: o.name,
    unit: str(o.unit) ? o.unit : "pcs",
    list_price: o.list_price,
    stock: o.stock,
  };
}

/** Shared customer-row validation — used for both the company file and the simulation package. */
function parseCustomerEntry(cu: unknown, i: number, path: string): CompanyCustomer {
  const o = (cu ?? {}) as Record<string, unknown>;
  const at = `customers[${i}]`;
  if (!str(o.name)) fail(path, `${at}.name is required`);
  if (!num(o.credit_limit) || o.credit_limit < 0) fail(path, `${at}.credit_limit must be a number >= 0`);
  const open = o.open_balance ?? 0;
  if (!num(open) || open < 0) fail(path, `${at}.open_balance must be a number >= 0`);
  return {
    id: str(o.id) ? o.id : `cust-${i + 1}`,
    name: o.name,
    email: str(o.email) ? o.email : null,
    country: str(o.country) ? o.country : null,
    credit_limit: o.credit_limit,
    open_balance: open,
    payment_terms: str(o.payment_terms) ? o.payment_terms : null,
  };
}

function checkNoDuplicateIds(path: string, label: string, list: Array<{ id: string }>): void {
  const ids = new Set<string>();
  for (const { id } of list) {
    if (ids.has(id)) fail(path, `${label} id ${JSON.stringify(id)} appears twice`);
    ids.add(id);
  }
}

export function parseCompany(raw: unknown, path = "(inline)"): Company {
  if (!raw || typeof raw !== "object") fail(path, "must be a JSON object");
  const c = raw as Record<string, unknown>;
  if (!str(c.name)) fail(path, "`name` is required");
  if (!str(c.currency) || !/^[A-Z]{3}$/.test(c.currency)) fail(path, "`currency` must be a 3-letter ISO code, e.g. EUR");
  if (!Array.isArray(c.items) || c.items.length === 0) fail(path, "`items` must be a non-empty list");
  if (!Array.isArray(c.customers) || c.customers.length === 0) fail(path, "`customers` must be a non-empty list");

  const skus = new Set<string>();
  const items = c.items.map((it, i) => parseItemEntry(it, i, path, "items", skus));
  const customers = c.customers.map((cu, i) => parseCustomerEntry(cu, i, path));

  checkNoDuplicateIds(path, "item", items);
  checkNoDuplicateIds(path, "customer", customers);

  return { name: c.name, currency: c.currency, items, customers };
}

export function loadCompanyFile(path: string): Company {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path, `cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseCompany(raw, path);
}

/**
 * Simulation package: the flat JSON format shared with the email simulator
 * (`name`, `currency`, `customers[]`, `products[]`). `products` accepts the
 * legacy key `items` as an alias (so a company file can be reused as a
 * package) but refuses a package that declares both, since then which one is
 * authoritative is ambiguous. `contacts` and `cases` are CRM/email-only parts
 * of the shared format — present in the same package for other connectors,
 * ignored here rather than rejected.
 */
export interface SimulationPackage {
  name: string;
  currency: string;
  customers: CompanyCustomer[];
  products: CompanyItem[];
}

export function parseSimulationPackage(raw: unknown, path = "(inline)"): SimulationPackage {
  if (!raw || typeof raw !== "object") fail(path, "must be a JSON object");
  const c = raw as Record<string, unknown>;
  if (!str(c.name)) fail(path, "`name` is required");
  if (!str(c.currency) || !/^[A-Z]{3}$/.test(c.currency)) fail(path, "`currency` must be a 3-letter ISO code, e.g. EUR");
  if (c.products !== undefined && c.items !== undefined) {
    fail(path, "must not declare both `products` and `items` — `items` is accepted only as a legacy alias for `products`");
  }
  const productsField = c.products !== undefined ? "products" : "items";
  const productsRaw = c.products !== undefined ? c.products : c.items;
  if (!Array.isArray(productsRaw) || productsRaw.length === 0) fail(path, "`products` must be a non-empty list");
  if (!Array.isArray(c.customers) || c.customers.length === 0) fail(path, "`customers` must be a non-empty list");

  const skus = new Set<string>();
  const products = productsRaw.map((it, i) => parseItemEntry(it, i, path, productsField, skus));
  const customers = c.customers.map((cu, i) => parseCustomerEntry(cu, i, path));

  checkNoDuplicateIds(path, "product", products);
  checkNoDuplicateIds(path, "customer", customers);

  return { name: c.name, currency: c.currency, customers, products };
}
