/**
 * `clear_simulation` — deletes all test data so the same cases can run again under
 * another setup, or other cases under the same setup: clear, then load.
 *
 * - live mode refuses it like every other tool, deleting nothing;
 * - it deletes every table that holds test data, changes and refusals included;
 * - the clear itself stays recorded as one change with its receipt_id (the trace
 *   of its ticket), and that row does not block the next load;
 * - clear → load → work → clear → load runs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, readFileSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { LIVE_NOT_AVAILABLE } from "../src/mode.js";
import { callTool } from "../src/dispatch.js";
import { ALREADY_LOADED_MESSAGE } from "../src/tools/simulation.js";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
const TABLES = ["items", "customers", "quotes", "quote_lines", "orders", "refusals", "triggers", "simulation_load"];

let dbPath = "";
let db: Db | undefined;

async function freshDb() {
  dbPath = join(tmpdir(), `erp-clear-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
  return db;
}

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined;
  dbPath = "";
});

/** Load the package, then make one quote → order and one refused call. */
async function useIt(db: Db) {
  await callTool(db, "simulation", "load_simulation", { package: pkg, receipt_id: "t-load" });
  const items = (await callTool(db, "simulation", "list_items", {})) as any[];
  const customers = (await callTool(db, "simulation", "find_customers", {})) as any[];
  const value = Math.round(items[0].list_price * 100) / 100;
  const q = (await callTool(db, "simulation", "create_quote", {
    customer_id: customers[0].id, lines: [{ item_id: items[0].id, qty: 1 }], discount_pct: 0, value, currency: pkg.currency, receipt_id: "t-q",
  })) as any;
  await callTool(db, "simulation", "send_quote", { id: q.id, value, discount_pct: 0, currency: pkg.currency });
  await callTool(db, "simulation", "convert_quote_to_order", { id: q.id, value, discount_pct: 0, currency: pkg.currency });
  await expect(callTool(db, "simulation", "load_simulation", { package: pkg, receipt_id: "t-refused" })).rejects.toThrow(ALREADY_LOADED_MESSAGE);
  await db.run(`INSERT INTO triggers (scenario_id, request) VALUES ('s1', 'r')`);
}

const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`))!.n;

describe("clear_simulation", () => {
  it("live mode refuses it and deletes nothing", async () => {
    const db = await freshDb();
    await useIt(db);
    await expect(callTool(db, "live", "clear_simulation", { receipt_id: "t-clear" })).rejects.toThrow(LIVE_NOT_AVAILABLE);
    expect(await count(db, "orders")).toBe(1);
    expect(await count(db, "simulation_load")).toBe(1);
  });

  it("deletes every table that holds test data, and records only the clear itself", async () => {
    const db = await freshDb();
    await useIt(db);
    for (const t of TABLES) expect(await count(db, t), t).toBeGreaterThan(0);

    const result = (await callTool(db, "simulation", "clear_simulation", { receipt_id: "t-clear" })) as any;
    expect(result.cleared).toBe(true);
    expect(result.deleted).toMatchObject({ orders: 1, quotes: 1, simulation_load: 1, refusals: 1 });

    for (const t of TABLES) expect(await count(db, t), t).toBe(0);
    expect(await db.all(`SELECT tool, receipt_id FROM changes`)).toEqual([{ tool: "clear_simulation", receipt_id: "t-clear" }]);
  });

  it("clear → load → work → clear → load runs", async () => {
    const db = await freshDb();
    await callTool(db, "simulation", "clear_simulation", {}); // on an empty ERP: harmless
    await useIt(db);
    await callTool(db, "simulation", "clear_simulation", { receipt_id: "t-clear" });
    const again = (await callTool(db, "simulation", "load_simulation", { package: pkg, receipt_id: "t-load-2" })) as any;
    expect(again.products_loaded).toBe(pkg.products.length);
    expect(await db.all(`SELECT tool, receipt_id FROM changes ORDER BY at, rowid`)).toEqual([
      { tool: "clear_simulation", receipt_id: "t-clear" },
      { tool: "load_simulation", receipt_id: "t-load-2" },
    ]);
  });
});
