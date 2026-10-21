/**
 * Mode/adapter wiring: ERP_MODE=live + ERP_LIVE_ADAPTER=local routes through
 * the main dispatch to the local adapter; every tool that only makes sense
 * for the simulation (items/quotes/orders/load_simulation/clear_simulation)
 * is refused clearly, naming what IS available — not silently missing.
 * live mode WITHOUT an adapter still refuses everything with
 * LIVE_NOT_AVAILABLE (unchanged pre-existing behavior, re-pinned here using
 * the explicit `env` parameter so it never depends on process.env state).
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDb, type Db } from "../../src/db.js";
import { callTool } from "../../src/dispatch.js";
import { LIVE_NOT_AVAILABLE, getLiveAdapter } from "../../src/mode.js";
import { LOCAL_TOOL_NAMES, mergeHandlerAreas } from "../../src/live/local/dispatch.js";
import { LOCAL_TOOL_DEFINITIONS } from "../../src/live/local/definitions.js";
import { QUOTE_TOOL_DEFINITIONS } from "../../src/live/local/definitions-quotes.js";
import { ITEM_TOOL_DEFINITIONS } from "../../src/live/local/definitions-items.js";
import { QUOTE_TOOL_HANDLERS } from "../../src/live/local/tools/quotes.js";
import { ITEM_TOOL_HANDLERS } from "../../src/live/local/tools/items.js";
import { addCustomer } from "../../src/live/local/tools/customers.js";
import { createLocalDb } from "../../src/live/local/db.js";

const MUSTER_COMPANY_JSON = {
  name: "Suveren", owner: "Andreas Schadauer MUSTER",
  address: { street: "MUSTER-Straße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
  uid: "ATU00000000", email: "andreas@sublin.app", web: "www.suveren.ai", register: null,
  bank: { name: "MUSTER Bank", iban: "AT00", bic: "MUSTERBIC" },
  default_payment_term_days: 14, vat_mode: "normal",
};

let dataDir: string;
let dbPath: string;
let db: Db;

afterEach(async () => {
  if (db) await db.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

describe("getLiveAdapter", () => {
  it("is undefined when unset", () => {
    expect(getLiveAdapter({})).toBeUndefined();
  });
  it("reads \"local\"", () => {
    expect(getLiveAdapter({ ERP_LIVE_ADAPTER: "Local " })).toBe("local");
  });
  it("throws on an unknown adapter", () => {
    expect(() => getLiveAdapter({ ERP_LIVE_ADAPTER: "sap" })).toThrow(/ERP_LIVE_ADAPTER must be one of local/);
  });
});

describe("live mode without an adapter — unchanged", () => {
  it("still refuses with LIVE_NOT_AVAILABLE, explicit env, no process.env mutation", async () => {
    dbPath = join(tmpdir(), `erp-dispatch-${Date.now()}.db`);
    process.env.DATABASE_URL = dbPath;
    db = await createDb();
    await expect(callTool(db, "live", "list_items", {}, {})).rejects.toThrow(LIVE_NOT_AVAILABLE);
  });
});

describe("live mode, adapter=local — tool availability", () => {
  function envFor(dataDirArg: string) {
    return {
      ERP_LIVE_ADAPTER: "local",
      ERP_LIVE_COMPANY_FILE: join(dataDirArg, "company.json"),
      HAP_DATA_DIR: dataDirArg,
    } as NodeJS.ProcessEnv;
  }

  async function setup() {
    dataDir = mkdtempSync(join(tmpdir(), "erp-dispatch-local-"));
    writeFileSync(join(dataDir, "company.json"), JSON.stringify(MUSTER_COMPANY_JSON));
    dbPath = join(dataDir, "erp-local.sqlite");
    // Mirrors index.ts: live+local mode is served from the LOCAL db, not the
    // simulation's — passing a simulation db here would be the same bug
    // index.ts's mode-based db selection exists to prevent.
    db = await createLocalDb(dbPath);
  }

  it("refuses load_simulation/clear_simulation, naming the available tools", async () => {
    await setup();
    const env = envFor(dataDir);
    for (const name of ["load_simulation", "clear_simulation"]) {
      const err = await callTool(db, "live", name, {}, env).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not available in local live mode/);
      expect((err as Error).message).toContain("find_customers");
    }
  });

  it("refuses send_quote / convert_quote_to_order and every order tool — Local has no send step and no orders (D3)", async () => {
    await setup();
    const env = envFor(dataDir);
    for (const name of ["send_quote", "convert_quote_to_order", "list_orders", "get_order"]) {
      await expect(callTool(db, "live", name, {}, env)).rejects.toThrow(/not available in local live mode/);
    }
  });

  it("allows find_customers (an empty read) through the full dispatch wiring", async () => {
    await setup();
    const env = envFor(dataDir);
    const result = await callTool(db, "live", "find_customers", {}, env);
    expect(result).toEqual([]);
  });

  it("customer writes get the VIES client built from env (ERP_VIES=off → saved as not checked, no call)", async () => {
    await setup();
    const env = { ...envFor(dataDir), ERP_VIES: "off" } as NodeJS.ProcessEnv;
    const c = (await callTool(db, "live", "create_customer", {
      name: "Kessler GmbH", address_lines: ["Hafenstraße 4"], country: "DE", uid: "DE123456789",
    }, env)) as any;
    expect(c.vies).toMatchObject({ status: "not_checked", reason: "VIES check switched off" });
  });

  it("customer writes call the VIES endpoint from ERP_VIES_URL (unreachable → not checked, still saved)", async () => {
    await setup();
    const env = { ...envFor(dataDir), ERP_VIES_URL: "http://127.0.0.1:1/vies", ERP_VIES_TIMEOUT_MS: "500" } as NodeJS.ProcessEnv;
    const c = (await callTool(db, "live", "create_customer", {
      name: "Kessler GmbH", address_lines: ["Hafenstraße 4"], country: "DE", uid: "DE123456789",
    }, env)) as any;
    expect(c.vies.status).toBe("not_checked");
    expect(c.vies.reason).toMatch(/^VIES unreachable/);
  });

  it("LOCAL_TOOL_NAMES matches exactly what the dispatcher accepts", () => {
    expect(LOCAL_TOOL_NAMES).toEqual([
      "find_customers", "get_customer", "create_customer", "update_customer", "update_customer_tax_data",
      "check_vat_id", "preview_customer_change", "create_invoice", "preview_invoice", "create_credit_note",
      "get_invoice", "list_invoices", "get_credit_note", "list_credit_notes", "get_document",
      ...QUOTE_TOOL_DEFINITIONS.map((d) => d.name),
      "list_items", "get_item", "create_item", "update_item", "update_item_price",
    ]);
  });
});

describe("local tool registry (contract §9, A1)", () => {
  it("LOCAL_TOOL_NAMES is exactly the merged definitions, in order, with no duplicates", () => {
    expect(LOCAL_TOOL_NAMES).toEqual(LOCAL_TOOL_DEFINITIONS.map((d) => d.name));
    expect(new Set(LOCAL_TOOL_NAMES).size).toBe(LOCAL_TOOL_NAMES.length);
  });

  it("the quote area (Part B) defines and handles the same five tools", () => {
    const names = ["list_quotes", "get_quote", "create_quote", "update_quote", "preview_quote"];
    expect(QUOTE_TOOL_DEFINITIONS.map((d) => d.name)).toEqual(names);
    expect(Object.keys(QUOTE_TOOL_HANDLERS)).toEqual(names);
  });

  it("the item area (Part C) defines and handles the same five tools", () => {
    const names = ["list_items", "get_item", "create_item", "update_item", "update_item_price"];
    expect(ITEM_TOOL_DEFINITIONS.map((d) => d.name)).toEqual(names);
    expect(Object.keys(ITEM_TOOL_HANDLERS)).toEqual(names);
  });

  it("a tool name claimed by two areas is refused at load, naming both", () => {
    const h = async () => null;
    expect(() => mergeHandlerAreas({ core: { get_quote: h }, quotes: { get_quote: h } })).toThrow(
      /"get_quote" is registered by both core and quotes/
    );
  });

  it("create_invoice and preview_invoice accept an optional customer_revision", () => {
    for (const name of ["create_invoice", "preview_invoice"]) {
      const def = LOCAL_TOOL_DEFINITIONS.find((d) => d.name === name)!;
      expect(def.inputSchema.properties).toHaveProperty("customer_revision");
      expect(def.inputSchema.required).not.toContain("customer_revision");
    }
  });
});

describe("CLI customers add — revision 1", () => {
  it("writes revision 1; the revision row exists after the next open", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "erp-dispatch-cli-"));
    dbPath = join(dataDir, "erp-local.sqlite");
    db = await createLocalDb(dbPath);
    const c = await addCustomer(db, { name: "MUSTER GmbH", address_lines: ["Weg 1"], country: "AT" });
    expect((await db.get<any>("SELECT revision FROM local_customers WHERE id = ?", [c.id])).revision).toBe(1);
    await db.close();
    db = await createLocalDb(dbPath);
    const rev = await db.get<any>("SELECT * FROM local_master_revisions WHERE entity = 'customer' AND entity_id = ?", [c.id]);
    expect(rev.revision).toBe(1);
    expect(JSON.parse(rev.content).name).toBe("MUSTER GmbH");
  });
});
