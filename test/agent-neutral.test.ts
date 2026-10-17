/**
 * The agent under test must not be able to tell the simulated ERP from a real
 * one (decision 2026-10-02): realistic measurement; safety comes from the
 * gateway's simulation mode. Nothing a working tool shows — definitions or
 * results — may say "simulated". load_simulation and clear_simulation are exempt (the
 * gateway hides them from agents without a setup mandate).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { callTool } from "../src/dispatch.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";

const LEAK = /simulat/i;
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
let db: Db;
let dbPath: string;

beforeEach(async () => {
  dbPath = join(tmpdir(), `erp-neutral-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
});
afterEach(async () => { await db.close(); rmSync(dbPath, { force: true }); });

describe("nothing the working agent sees reveals the simulation", () => {
  it("tool names, descriptions and argument descriptions", () => {
    const working = TOOL_DEFINITIONS.filter((t) => t.name !== "load_simulation" && t.name !== "clear_simulation");
    expect(working.length).toBe(18);
    expect(JSON.stringify(working)).not.toMatch(LEAK);
  });

  it("tool results across the quote → send → order → invoice → credit note flow", async () => {
    await callTool(db, "simulation", "load_simulation", { package: pkg });
    const out: unknown[] = [];
    const items = (await callTool(db, "simulation", "list_items", {})) as any[];
    const customers = (await callTool(db, "simulation", "find_customers", {})) as any[];
    out.push(items, customers, await callTool(db, "simulation", "get_customer", { id: customers[0].id }));
    const value = Math.round(2 * items[0].list_price * 100) / 100;
    const q = (await callTool(db, "simulation", "create_quote", {
      customer_id: customers[0].id, lines: [{ item_id: items[0].id, qty: 2 }], discount_pct: 0, value, currency: pkg.currency,
    })) as any;
    out.push(q, await callTool(db, "simulation", "send_quote", { id: q.id, value, discount_pct: 0, currency: pkg.currency, revision: q.revision }));
    const order = (await callTool(db, "simulation", "convert_quote_to_order", { id: q.id, value, discount_pct: 0, currency: pkg.currency, revision: q.revision })) as any;
    out.push(order);
    out.push(await callTool(db, "simulation", "list_quotes", {}), await callTool(db, "simulation", "list_orders", {}));

    const netTotal = order.lines.reduce((sum: number, l: any) => sum + l.qty * l.list_price, 0);
    const invoice = (await callTool(db, "simulation", "create_invoice", {
      customer_id: customers[0].id, order_id: order.id, net_total: netTotal, currency: pkg.currency,
    })) as any;
    out.push(invoice, await callTool(db, "simulation", "get_invoice", { id: invoice.id }), await callTool(db, "simulation", "list_invoices", {}));

    const creditNote = (await callTool(db, "simulation", "create_credit_note", {
      invoice_id: invoice.id, credit_total: invoice.net_total, currency: pkg.currency, reason: "returned goods",
    })) as any;
    out.push(creditNote, await callTool(db, "simulation", "get_credit_note", { id: creditNote.id }), await callTool(db, "simulation", "list_credit_notes", {}));

    expect(JSON.stringify(out)).not.toMatch(LEAK);
  });
});
