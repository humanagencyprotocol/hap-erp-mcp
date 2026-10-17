/**
 * Tool routing for live mode's "local" adapter. Deliberately narrow: no
 * catalog items, no quotes, no orders — those concepts don't exist for
 * Suveren's own invoicing, so load_simulation/clear_simulation and every
 * item/quote/order/sales tool are refused clearly here rather than silently
 * missing, naming what IS available.
 */
import { homedir } from "os";
import { join } from "path";
import type { Db } from "../../db.js";
import { resolveLiveCompany, type LiveCompany } from "./company-file.js";
import { resolveTemplate } from "./template.js";
import { find_customers, get_customer } from "./tools/customers.js";
import {
  create_invoice,
  preview_invoice,
  create_credit_note,
  get_invoice,
  list_invoices,
  get_credit_note,
  list_credit_notes,
  get_document,
  type LocalCtx,
} from "./tools/invoices.js";

export const LOCAL_TOOL_NAMES: readonly string[] = [
  "find_customers",
  "get_customer",
  "create_invoice",
  "preview_invoice",
  "create_credit_note",
  "get_invoice",
  "list_invoices",
  "get_credit_note",
  "list_credit_notes",
  "get_document",
];

export function resolveLocalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAP_DATA_DIR ?? join(homedir(), ".hap");
}

export function buildLocalCtx(env: NodeJS.ProcessEnv = process.env): LocalCtx {
  const company: LiveCompany = resolveLiveCompany(env);
  const { template } = resolveTemplate(env);
  const dataDir = resolveLocalDataDir(env);
  return { company, template, dataDir };
}

async function runLocalTool(db: Db, name: string, args: Record<string, any>, ctx: LocalCtx): Promise<unknown> {
  switch (name) {
    case "find_customers": return find_customers(db, args);
    case "get_customer": return get_customer(db, args);
    case "create_invoice": return create_invoice(db, args, ctx);
    case "preview_invoice": return preview_invoice(db, args, ctx);
    case "create_credit_note": return create_credit_note(db, args, ctx);
    case "get_invoice": return get_invoice(db, args);
    case "list_invoices": return list_invoices(db, args);
    case "get_credit_note": return get_credit_note(db, args);
    case "list_credit_notes": return list_credit_notes(db, args);
    case "get_document": return get_document(db, args);
    default:
      throw new Error(
        `Refused: "${name}" is not available in local live mode (no catalog items, quotes, orders, or simulation setup here). ` +
          `Available tools: ${LOCAL_TOOL_NAMES.join(", ")}.`
      );
  }
}

export async function callLocalTool(db: Db, name: string, args: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  if (!LOCAL_TOOL_NAMES.includes(name)) {
    throw new Error(
      `Refused: "${name}" is not available in local live mode (no catalog items, quotes, orders, or simulation setup here). ` +
        `Available tools: ${LOCAL_TOOL_NAMES.join(", ")}.`
    );
  }
  const ctx = buildLocalCtx(env);
  return runLocalTool(db, name, args, ctx);
}
