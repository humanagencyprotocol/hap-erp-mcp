/**
 * `load_simulation` — create-only load of a simulation package into the
 * simulated ERP. Refusals are exercised harder than the success path, per
 * doc/engineering.md: the product's value is in what it refuses.
 *
 * - live mode refuses it like every other tool;
 * - a new ERP starts empty; the first load fills it with exactly the package;
 * - a load on a database that already holds customers or products is refused;
 * - a second load, or a load after any business change, is refused AND
 *   recorded in `refusals` with the gateway's receipt_id — the only trace that
 *   a ticket exists for an action that never happened;
 * - an invalid package is refused whole, naming the field;
 * - `cases` is accepted but ignored;
 * - the package hash is stable regardless of key order.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, readFileSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { DEMO_COMPANY } from "./fixtures/demo-company.js";
import { parseSimulationPackage, loadCompanyFile } from "../src/company.js";
import { LIVE_NOT_AVAILABLE } from "../src/mode.js";
import { callTool } from "../src/dispatch.js";
import { load_simulation, ALREADY_LOADED_MESSAGE } from "../src/tools/simulation.js";
import { canonicalSha256 } from "../src/package-hash.js";
import { exportRecord } from "../src/cli.js";

const tmp = (ext: string) => join(tmpdir(), `erp-loadsim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

let dbPath: string;
let db: Db;

async function freshDb(company?: typeof DEMO_COMPANY) {
  dbPath = tmp("db");
  process.env.DATABASE_URL = dbPath;
  db = await createDb(company);
}

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined as unknown as Db;
  dbPath = "";
});

const PACKAGE = {
  name: "Bergmann Ersatzteile GmbH",
  currency: "EUR",
  products: [
    { sku: "SP-100", name: "Hydraulic seal kit", unit: "set", list_price: 84.5, stock: 40 },
    { sku: "SP-200", name: "Bearing set 6204", unit: "set", list_price: 120.0, stock: 10 },
  ],
  customers: [
    { name: "Huber Maschinenbau GmbH", email: "einkauf@huber.example", country: "AT", credit_limit: 15000, open_balance: 2000 },
    { name: "Steiner Anlagentechnik KG", email: "office@steiner.example", country: "DE", credit_limit: 4000, open_balance: 3500 },
  ],
  cases: [
    { id: "case-1", request: { from: { name: "X", email: "x@example.com" }, subject: "s", body: "b" }, reply: { subject: "re: s", body: "r" } },
  ],
};

describe("live mode", () => {
  it("refuses load_simulation like every other tool, touching nothing", async () => {
    await freshDb();
    await expect(callTool(db, "live", "load_simulation", { package: PACKAGE, receipt_id: "t-1" })).rejects.toThrow(LIVE_NOT_AVAILABLE);
    expect(await db.all(`SELECT * FROM simulation_load`)).toHaveLength(0);
  });
});

describe("first load", () => {
  it("fills the empty ERP with exactly the package's customers and products", async () => {
    await freshDb();
    expect(await db.all(`SELECT * FROM items`)).toHaveLength(0); // no demo data

    const result = (await callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-load" })) as any;
    expect(result).toMatchObject({ name: PACKAGE.name, customers_loaded: 2, products_loaded: 2 });
    expect(typeof result.package_sha256).toBe("string");
    expect(result.package_sha256).toHaveLength(64);

    const items = await db.all<any>(`SELECT sku FROM items ORDER BY sku`);
    expect(items.map((i) => i.sku)).toEqual(["SP-100", "SP-200"]);
    const customers = await db.all<any>(`SELECT name FROM customers ORDER BY name`);
    expect(customers.map((c) => c.name)).toEqual(["Huber Maschinenbau GmbH", "Steiner Anlagentechnik KG"]);
  });

  it("is recorded as a change with the gateway's receipt_id", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-load" });
    const rows = await db.all<any>(`SELECT tool, receipt_id FROM changes`);
    expect(rows).toEqual([{ tool: "load_simulation", receipt_id: "t-load" }]);
  });

  it("stores name and sha256 in simulation_load", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-load" });
    const rows = await db.all<any>(`SELECT name, package_sha256 FROM simulation_load`);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(PACKAGE.name);
    expect(rows[0].package_sha256).toBe(canonicalSha256(PACKAGE));
  });

  it("accepts the legacy `items` key as an alias for `products`", async () => {
    await freshDb();
    const { products, ...rest } = PACKAGE;
    const legacy = { ...rest, items: products };
    const result = (await callTool(db, "simulation", "load_simulation", { package: legacy })) as any;
    expect(result.products_loaded).toBe(2);
  });
});

describe("create only — refused, never edited", () => {
  it("refuses a second load and records the refusal with receipt_id", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-first" });
    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-second" }))
      .rejects.toThrow(ALREADY_LOADED_MESSAGE);
    const refusals = await db.all<any>(`SELECT tool, receipt_id FROM refusals`);
    expect(refusals).toEqual([{ tool: "load_simulation", receipt_id: "t-second" }]);
    // The first load's data must be untouched by the refused second attempt.
    expect(await db.all(`SELECT * FROM customers`)).toHaveLength(2);
  });

  it("refuses a load on a database that already holds customers and products (e.g. from a company file)", async () => {
    await freshDb(DEMO_COMPANY);
    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-x" }))
      .rejects.toThrow(ALREADY_LOADED_MESSAGE);
    expect(await db.all(`SELECT * FROM items`)).toHaveLength(DEMO_COMPANY.items.length); // untouched
  });

  it("refuses a load after a quote was created (a business change, no prior load_simulation call)", async () => {
    await freshDb(DEMO_COMPANY);
    const items = await db.all<any>(`SELECT id FROM items LIMIT 1`);
    const customers = await db.all<any>(`SELECT id FROM customers LIMIT 1`);
    await callTool(db, "simulation", "create_quote", {
      customer_id: customers[0].id, lines: [{ item_id: items[0].id, qty: 1 }], discount_pct: 0, value: DEMO_COMPANY.items[0].list_price, currency: "EUR",
    });
    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-x" }))
      .rejects.toThrow(ALREADY_LOADED_MESSAGE);
  });

  it("refuses a load after an order exists", async () => {
    await freshDb(DEMO_COMPANY);
    const item = (await db.all<any>(`SELECT id FROM items LIMIT 1`))[0];
    const customer = (await db.all<any>(`SELECT id FROM customers WHERE credit_limit > 1000 LIMIT 1`))[0];
    const q = (await callTool(db, "simulation", "create_quote", {
      customer_id: customer.id, lines: [{ item_id: item.id, qty: 1 }], discount_pct: 0, value: DEMO_COMPANY.items[0].list_price, currency: "EUR",
    })) as any;
    await callTool(db, "simulation", "send_quote", { id: q.id, value: q.net_total, discount_pct: 0, currency: "EUR" });
    await callTool(db, "simulation", "convert_quote_to_order", { id: q.id, value: q.net_total, discount_pct: 0, currency: "EUR" });
    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE })).rejects.toThrow(ALREADY_LOADED_MESSAGE);
  });

  describe("control check — the guard must actually block (sanity-checked manually, not part of CI)", () => {
    it("documents the refusal message tests assert on", () => {
      // See report: the guard (assertLoadable in src/tools/simulation.ts) was
      // temporarily disabled and this suite re-run to confirm every refusal
      // test above fails without it, then restored.
      expect(ALREADY_LOADED_MESSAGE).toMatch(/already loaded/);
    });
  });
});

describe("invalid package — refused whole, naming the field", () => {
  it.each([
    ["missing products", { name: "X", currency: "EUR", customers: PACKAGE.customers }, /`products` must be a non-empty list/],
    ["a duplicate sku", { ...PACKAGE, products: [PACKAGE.products[0], PACKAGE.products[0]] }, /sku "SP-100" appears twice/],
    ["both items and products", { ...PACKAGE, items: PACKAGE.products }, /must not declare both `products` and `items`/],
    ["missing customers", { name: "X", currency: "EUR", products: PACKAGE.products }, /`customers` must be a non-empty list/],
    ["a bad currency", { ...PACKAGE, currency: "euro" }, /currency/],
  ])("refuses on %s", (_label, bad, msg) => {
    expect(() => parseSimulationPackage(bad)).toThrow(msg);
  });

  it("the refusal happens before anything is written", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "load_simulation", { package: { name: "X" }, receipt_id: "t-bad" })).rejects.toThrow();
    expect(await db.all(`SELECT * FROM simulation_load`)).toHaveLength(0);
    const refusals = await db.all<any>(`SELECT tool, receipt_id FROM refusals`);
    expect(refusals).toEqual([{ tool: "load_simulation", receipt_id: "t-bad" }]);
  });
});

describe("cases — ignored, not validated", () => {
  it("a package with an invalid `cases` entry still loads (cases is not read by the ERP)", async () => {
    await freshDb();
    const withJunkCases = { ...PACKAGE, cases: "not even an array" };
    const result = (await callTool(db, "simulation", "load_simulation", { package: withJunkCases })) as any;
    expect(result.customers_loaded).toBe(2);
  });
});

describe("package hash", () => {
  it("is stable regardless of top-level and nested object key order", () => {
    // Top-level keys reversed, and every customer object's own keys reversed too.
    const reorderedCustomers = PACKAGE.customers.map((c) => {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(c).reverse()) o[k] = (c as any)[k];
      return o;
    });
    const reordered = {
      cases: PACKAGE.cases,
      customers: reorderedCustomers,
      products: PACKAGE.products,
      currency: PACKAGE.currency,
      name: PACKAGE.name,
    };
    expect(canonicalSha256(reordered)).toBe(canonicalSha256(PACKAGE));
  });

  it("array element ORDER still matters — not just key order", () => {
    const sameSetDifferentOrder = { ...PACKAGE, customers: [...PACKAGE.customers].reverse() };
    expect(canonicalSha256(sameSetDifferentOrder)).not.toBe(canonicalSha256(PACKAGE));
  });

  it("differs when content differs", () => {
    expect(canonicalSha256(PACKAGE)).not.toBe(canonicalSha256({ ...PACKAGE, name: "Different" }));
  });
});

describe("the shipped example package is valid", () => {
  it("parses with the expected shape", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
    const pkg = parseSimulationPackage(raw);
    expect(pkg.products.length).toBe(3);
    expect(pkg.customers.length).toBe(2);
  });

  it("the old company example still works unchanged", () => {
    const c = loadCompanyFile(join(__dirname, "..", "examples", "company.example.json"));
    expect(c.items.length).toBeGreaterThan(0);
    expect(c.customers.length).toBeGreaterThan(0);
  });
});

describe("export", () => {
  it("includes simulation_load", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, receipt_id: "t-export" });
    const rec = await exportRecord(db, "simulation");
    expect(rec.simulation_load).toEqual([expect.objectContaining({ name: PACKAGE.name })]);
  });
});
