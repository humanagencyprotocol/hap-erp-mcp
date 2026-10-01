/**
 * Simulation mode: the three-week test runs on this connector, its tools and its
 * profile — only the system behind it is simulated. These tests pin what makes
 * that test trustworthy:
 *
 * - live mode refuses loudly (no adapter in 0.x) and touches nothing — a go-live
 *   that is secretly still simulated, or a test that believes it is live, must
 *   not be silent;
 * - the company file is loaded whole or refused whole;
 * - a call refused after the gateway let it through is recorded with its
 *   receipt_id — the only trace that a ticket exists for an action that never
 *   happened;
 * - request hand-over times are recorded, and the export lines up
 *   trigger → ticket (receipt_id) → effect.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, writeFileSync } from "fs";
import { createDb, resolveCompany, DEMO_COMPANY, type Db } from "../src/db.js";
import { parseCompany } from "../src/company.js";
import { getMode, LIVE_NOT_AVAILABLE } from "../src/mode.js";
import { callTool } from "../src/dispatch.js";
import { loadScenario, nextRequest, exportRecord } from "../src/cli.js";

const tmp = (ext: string) => join(tmpdir(), `erp-sim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

let dbPath: string;
let db: Db;

async function freshDb(company = DEMO_COMPANY) {
  dbPath = tmp("db");
  process.env.DATABASE_URL = dbPath;
  db = await createDb(company);
}

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined as unknown as Db;
  dbPath = "";
  delete process.env.ERP_COMPANY_FILE;
});

const quote = (over: Record<string, unknown> = {}) => ({
  customer_id: "cust-4", lines: [{ item_id: "item-7", qty: 1 }, { item_id: "item-1", qty: 1 }],
  discount_pct: 0, value: 37, currency: "EUR", ...over,
});

describe("mode switch", () => {
  it("defaults to simulation", () => {
    expect(getMode({})).toBe("simulation");
    expect(getMode({ ERP_MODE: "Simulation " })).toBe("simulation");
  });

  it("refuses an unknown mode at start instead of guessing", () => {
    expect(() => getMode({ ERP_MODE: "production" })).toThrow(/ERP_MODE must be one of simulation, live/);
  });

  it("live mode refuses every tool, reads included, and changes nothing", async () => {
    await freshDb();
    await expect(callTool(db, "live", "list_items", {})).rejects.toThrow(LIVE_NOT_AVAILABLE);
    await expect(callTool(db, "live", "create_quote", { ...quote(), receipt_id: "t-1" })).rejects.toThrow(/live mode/);
    expect(await db.all(`SELECT * FROM quotes`)).toHaveLength(0);
    // Nothing local refused it — there is no local system in live mode — so nothing is recorded.
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
  });
});

describe("company file", () => {
  const company = {
    name: "Bergmann Ersatzteile GmbH", currency: "EUR",
    items: [{ sku: "SP-100", name: "Hydraulic seal kit", list_price: 84.5, stock: 40 }],
    customers: [{ name: "Huber Maschinenbau", country: "AT", credit_limit: 15000, open_balance: 2000 }],
  };

  it("seeds an empty database from the file", async () => {
    const path = tmp("json");
    writeFileSync(path, JSON.stringify(company));
    process.env.ERP_COMPANY_FILE = path;
    await freshDb(resolveCompany());
    const items = (await callTool(db, "simulation", "list_items", {})) as any[];
    expect(items).toEqual([expect.objectContaining({ id: "item-1", sku: "SP-100", list_price: 84.5, currency: "EUR", stock: 40 })]);
    const cust = (await callTool(db, "simulation", "get_customer", { id: "cust-1" })) as any;
    expect(cust).toMatchObject({ name: "Huber Maschinenbau", available_credit: 13000 });
    rmSync(path, { force: true });
  });

  it("the refusals still hold on seeded data — over the credit limit", async () => {
    await freshDb(parseCompany(company));
    const q = (await callTool(db, "simulation", "create_quote", {
      customer_id: "cust-1", lines: [{ item_id: "item-1", qty: 40 }], discount_pct: 0, value: 3380, currency: "EUR",
    })) as any;
    await callTool(db, "simulation", "send_quote", { id: q.id, value: 3380, discount_pct: 0, currency: "EUR" });
    // 2,000 open + 3,380 is within 15,000 — so drop the limit to prove the check reads the seeded row.
    await db.run(`UPDATE customers SET credit_limit = 4000 WHERE id = 'cust-1'`);
    await expect(callTool(db, "simulation", "convert_quote_to_order", { id: q.id, value: 3380, discount_pct: 0, currency: "EUR" }))
      .rejects.toThrow(/credit/i);
  });

  it.each([
    ["a duplicate sku", { ...company, items: [company.items[0], company.items[0]] }, /sku "SP-100" appears twice/],
    ["a missing price", { ...company, items: [{ sku: "X", name: "X", stock: 1 }] }, /items\[0\]\.list_price/],
    ["fractional stock", { ...company, items: [{ sku: "X", name: "X", list_price: 1, stock: 1.5 }] }, /items\[0\]\.stock/],
    ["a bad currency", { ...company, currency: "euro" }, /currency/],
    ["no customers", { ...company, customers: [] }, /customers/],
  ])("refuses the whole file on %s", (_label, bad, msg) => {
    expect(() => parseCompany(bad)).toThrow(msg);
  });

  it("the shipped example company file is valid", () => {
    const c = resolveCompany({ ERP_COMPANY_FILE: join(__dirname, "..", "examples", "company.example.json") });
    expect(c.items.length).toBeGreaterThan(0);
    expect(c.customers.length).toBeGreaterThan(0);
  });

  it("the shipped example scenario is valid", () => {
    expect(loadScenario(join(__dirname, "..", "examples", "scenario.example.json")).length).toBeGreaterThan(0);
  });

  it("refuses an unreadable file at start rather than falling back to the demo", () => {
    expect(() => resolveCompany({ ERP_COMPANY_FILE: tmp("json") })).toThrow(/cannot be read as JSON/);
  });
});

describe("refusals after the gateway let a call through", () => {
  beforeEach(() => freshDb());

  it("records a false declared value with the ticket's receipt_id", async () => {
    await expect(callTool(db, "simulation", "create_quote", { ...quote({ value: 20 }), receipt_id: "ticket-20eur" }))
      .rejects.toThrow(/declared 20, expected 37/);
    const rows = await db.all<any>(`SELECT * FROM refusals`);
    expect(rows).toEqual([expect.objectContaining({ tool: "create_quote", receipt_id: "ticket-20eur" })]);
    expect(rows[0].message).toMatch(/declared 20, expected 37/);
    expect(await db.all(`SELECT * FROM quotes`)).toHaveLength(0);
  });

  it("records a wrong state transition too (send of an unknown quote)", async () => {
    await expect(callTool(db, "simulation", "send_quote", { id: "nope", value: 1, discount_pct: 0, currency: "EUR", receipt_id: "t-x" }))
      .rejects.toThrow();
    expect(await db.all<any>(`SELECT receipt_id FROM refusals`)).toEqual([{ receipt_id: "t-x" }]);
  });

  it("does not record a failed read — reads carry no ticket", async () => {
    await expect(callTool(db, "simulation", "get_quote", { id: "nope" })).rejects.toThrow();
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
  });

  it("records a successful change as a change, not a refusal", async () => {
    await callTool(db, "simulation", "create_quote", { ...quote(), receipt_id: "t-ok" });
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
    expect(await db.all<any>(`SELECT tool, receipt_id, document_number, status, net_total FROM changes`)).toEqual([
      { tool: "create_quote", receipt_id: "t-ok", document_number: "Q-0001", status: "draft", net_total: 37 },
    ]);
  });

  it("keeps one change per ticket even when several tickets act on the same document", async () => {
    // The quote row only holds its latest receipt_id (send overwrites create). The
    // change record must still show both tickets — otherwise create's ticket has no trace.
    const q = (await callTool(db, "simulation", "create_quote", { ...quote(), receipt_id: "t-create" })) as any;
    await callTool(db, "simulation", "send_quote", { id: q.id, value: 37, discount_pct: 0, currency: "EUR", receipt_id: "t-send" });
    expect((await db.get<any>(`SELECT receipt_id FROM quotes WHERE id = ?`, [q.id]))!.receipt_id).toBe("t-send");
    expect((await db.all<any>(`SELECT receipt_id, status FROM changes ORDER BY at`))).toEqual([
      { receipt_id: "t-create", status: "draft" },
      { receipt_id: "t-send", status: "sent" },
    ]);
  });

  it("records no change for a read", async () => {
    await callTool(db, "simulation", "list_items", {});
    expect(await db.all(`SELECT * FROM changes`)).toHaveLength(0);
  });
});

describe("scenario and export", () => {
  beforeEach(() => freshDb());

  const scenarioFile = () => {
    const path = tmp("json");
    writeFileSync(path, JSON.stringify({ requests: [
      { id: "r1", request: "Meridian asks for 1 × Cable 5m and 1 × Widget 100", expected: { customer_id: "cust-4", value: 37 } },
      { id: "r2", request: "Alpine asks for 2 × Gear A1" },
    ] }));
    return path;
  };

  it("hands requests over in order, records the time, then reports done", async () => {
    const s = loadScenario(scenarioFile());
    expect((await nextRequest(db, s))?.id).toBe("r1");
    expect((await nextRequest(db, s))?.id).toBe("r2");
    expect(await nextRequest(db, s)).toBeNull();
    expect(await db.all(`SELECT scenario_id FROM triggers`)).toHaveLength(2);
  });

  it("refuses a scenario with duplicate ids", () => {
    const path = tmp("json");
    writeFileSync(path, JSON.stringify({ requests: [{ id: "a", request: "x" }, { id: "a", request: "y" }] }));
    expect(() => loadScenario(path)).toThrow(/appears twice/);
  });

  it("the export lines up trigger → receipt_id → effect, and states the mode", async () => {
    await nextRequest(db, loadScenario(scenarioFile()));
    const q = (await callTool(db, "simulation", "create_quote", { ...quote(), receipt_id: "t-quote" })) as any;
    await callTool(db, "simulation", "send_quote", { id: q.id, value: 37, discount_pct: 0, currency: "EUR", receipt_id: "t-send" });
    await callTool(db, "simulation", "create_quote", { ...quote({ value: 20 }), receipt_id: "t-false" }).catch(() => {});

    const rec = await exportRecord(db, "simulation");
    expect(rec.mode).toBe("simulation");
    expect(rec.triggers).toEqual([expect.objectContaining({ scenario_id: "r1", expected: { customer_id: "cust-4", value: 37 } })]);
    expect(rec.quotes).toEqual([expect.objectContaining({ number: "Q-0001", status: "sent", net_total: 37, receipt_id: "t-send" })]);
    expect(rec.quotes[0].lines).toHaveLength(2);
    expect(rec.refusals).toEqual([expect.objectContaining({ receipt_id: "t-false", tool: "create_quote" })]);
    expect(rec.changes.map((c: any) => [c.tool, c.receipt_id])).toEqual([["create_quote", "t-quote"], ["send_quote", "t-send"]]);
  });
});
