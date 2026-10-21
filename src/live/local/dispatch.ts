/**
 * Tool routing for live mode's "local" adapter. A registry: each area owns a
 * map of handlers (core invoicing + customers here, quotes in tools/quotes.ts,
 * catalogue items in tools/items.ts); this module merges them and checks that
 * the merged handlers and LOCAL_TOOL_DEFINITIONS name exactly the same tools.
 * Anything else — simulation setup, orders, simulator-only tools — is refused
 * clearly, naming what IS available, rather than silently missing.
 */
import { homedir } from "os";
import { join } from "path";
import type { Db } from "../../db.js";
import { resolveLiveCompany, type LiveCompany } from "./company-file.js";
import { resolveTemplate } from "./template.js";
import { LOCAL_TOOL_DEFINITIONS } from "./definitions.js";
import { find_customers, get_customer } from "./tools/customers.js";
import * as invoices from "./tools/invoices.js";
import type { LocalCtx } from "./tools/invoices.js";
import { QUOTE_TOOL_HANDLERS } from "./tools/quotes.js";
import { ITEM_TOOL_HANDLERS } from "./tools/items.js";

export type LocalToolHandler = (db: Db, args: Record<string, any>, ctx: LocalCtx) => Promise<unknown>;

const CORE_TOOL_HANDLERS: Readonly<Record<string, LocalToolHandler>> = {
  find_customers: (db, args) => find_customers(db, args),
  get_customer: (db, args) => get_customer(db, args),
  create_invoice: invoices.create_invoice,
  preview_invoice: invoices.preview_invoice,
  create_credit_note: invoices.create_credit_note,
  get_invoice: (db, args) => invoices.get_invoice(db, args),
  list_invoices: (db, args) => invoices.list_invoices(db, args),
  get_credit_note: (db, args) => invoices.get_credit_note(db, args),
  list_credit_notes: (db, args) => invoices.list_credit_notes(db, args),
  get_document: (db, args) => invoices.get_document(db, args),
};

/** Merges per-area handler maps; a name claimed by two areas is a programming error. */
export function mergeHandlerAreas(
  areas: Record<string, Readonly<Record<string, LocalToolHandler>>>
): Map<string, LocalToolHandler> {
  const merged = new Map<string, LocalToolHandler>();
  const owner = new Map<string, string>();
  for (const [area, handlers] of Object.entries(areas)) {
    for (const [name, handler] of Object.entries(handlers)) {
      if (merged.has(name)) throw new Error(`Local tool "${name}" is registered by both ${owner.get(name)} and ${area}.`);
      merged.set(name, handler);
      owner.set(name, area);
    }
  }
  return merged;
}

const LOCAL_TOOL_HANDLERS = mergeHandlerAreas({
  core: CORE_TOOL_HANDLERS,
  quotes: QUOTE_TOOL_HANDLERS,
  items: ITEM_TOOL_HANDLERS,
});

/** Tool names in definition order — what tools/list shows. */
export const LOCAL_TOOL_NAMES: readonly string[] = LOCAL_TOOL_DEFINITIONS.map((d) => d.name);

// Definitions and handlers must name the same tools — fail at load, not on a call.
{
  const defined = new Set(LOCAL_TOOL_NAMES);
  if (defined.size !== LOCAL_TOOL_NAMES.length) throw new Error("Local tool definitions contain a duplicate name.");
  const missing = LOCAL_TOOL_NAMES.filter((n) => !LOCAL_TOOL_HANDLERS.has(n));
  const extra = [...LOCAL_TOOL_HANDLERS.keys()].filter((n) => !defined.has(n));
  if (missing.length || extra.length) {
    throw new Error(`Local tool registry mismatch — no handler: [${missing.join(", ")}]; no definition: [${extra.join(", ")}].`);
  }
}

export function resolveLocalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAP_DATA_DIR ?? join(homedir(), ".hap");
}

export function buildLocalCtx(env: NodeJS.ProcessEnv = process.env): LocalCtx {
  const company: LiveCompany = resolveLiveCompany(env);
  const { template } = resolveTemplate(env);
  const dataDir = resolveLocalDataDir(env);
  return { company, template, dataDir };
}

export async function callLocalTool(db: Db, name: string, args: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const handler = LOCAL_TOOL_HANDLERS.get(name);
  if (!handler) {
    throw new Error(
      `Refused: "${name}" is not available in local live mode (no orders or simulation setup here). ` +
        `Available tools: ${LOCAL_TOOL_NAMES.join(", ")}.`
    );
  }
  const ctx = buildLocalCtx(env);
  return handler(db, args, ctx);
}
