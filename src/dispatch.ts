/**
 * One entry point for every tool call — used by the MCP server and by the tests,
 * so the tests exercise exactly what the server runs.
 */
import { randomUUID } from "crypto";
import type { Db } from "./db.js";
import { LIVE_NOT_AVAILABLE, type ErpMode } from "./mode.js";
import { list_items, get_item } from "./tools/items.js";
import { find_customers, get_customer } from "./tools/customers.js";
import { create_quote, update_quote, send_quote, list_quotes, get_quote } from "./tools/quotes.js";
import { convert_quote_to_order, list_orders, get_order } from "./tools/orders.js";
import { load_simulation, clear_simulation } from "./tools/simulation.js";

/** Tools that change the ERP — the ones the gateway issues a ticket for. */
export const CHANGE_TOOLS = new Set([
  "create_quote",
  "update_quote",
  "send_quote",
  "convert_quote_to_order",
  "load_simulation",
  "clear_simulation",
]);

async function runTool(db: Db, name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case "list_items": return list_items(db, args);
    case "get_item": return get_item(db, args);
    case "find_customers": return find_customers(db, args);
    case "get_customer": return get_customer(db, args);
    case "list_quotes": return list_quotes(db, args);
    case "get_quote": return get_quote(db, args);
    case "list_orders": return list_orders(db, args);
    case "get_order": return get_order(db, args);
    case "create_quote": return create_quote(db, args);
    case "update_quote": return update_quote(db, args);
    case "send_quote": return send_quote(db, args);
    case "convert_quote_to_order": return convert_quote_to_order(db, args);
    case "load_simulation": return load_simulation(db, args);
    case "clear_simulation": return clear_simulation(db, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Run a tool in the given mode. Every successful change is recorded (`changes`)
 * with the ticket_id the gateway injected; a refused change call is recorded with the
 * ticket_id the gateway injected — that is the trace of a ticket whose action
 * never happened. In live mode nothing runs and nothing is recorded locally:
 * there is no local system to have refused anything. Both tables store the id
 * in their existing receipt_id column (internal storage name, unchanged).
 */
export async function callTool(db: Db, mode: ErpMode, name: string, args: Record<string, any>): Promise<unknown> {
  if (mode === "live") throw new Error(LIVE_NOT_AVAILABLE);
  try {
    const result = await runTool(db, name, args);
    if (CHANGE_TOOLS.has(name)) {
      const doc = (result ?? {}) as Record<string, unknown>;
      await db.run(
        `INSERT INTO changes (id, at, tool, receipt_id, document_id, document_number, status, net_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(), new Date().toISOString(), name, typeof args.ticket_id === "string" ? args.ticket_id : null,
          doc.id ?? null, doc.number ?? null, doc.status ?? null, typeof doc.net_total === "number" ? doc.net_total : null,
        ],
      );
    }
    return result;
  } catch (err) {
    if (CHANGE_TOOLS.has(name)) {
      const message = err instanceof Error ? err.message : String(err);
      const ticketId = typeof args.ticket_id === "string" ? args.ticket_id : null;
      await db.run(`INSERT INTO refusals (id, at, tool, receipt_id, message) VALUES (?, ?, ?, ?, ?)`, [
        randomUUID(), new Date().toISOString(), name, ticketId, message,
      ]);
    }
    throw err;
  }
}
