/**
 * Same justification as test/mcp-output-schema.test.ts (simulation's
 * get_quote), applied to live mode's "local" adapter: get_document and
 * preview_invoice must carry an MCP `outputSchema` + `structuredContent` so
 * the gateway can actually read the rendered/archived PDF (and its sha256)
 * without erp-specific parsing of the text content — and that has to be
 * proven over the real stdio wire this connector speaks, not by calling the
 * tool functions directly (dispatch.ts/the local dispatch module never go
 * through index.ts's response shaping at all).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { createLocalDb } from "../../src/live/local/db.js";
import { addCustomer } from "../../src/live/local/tools/customers.js";
import { todayInTimezone } from "../../src/live/local/date.js";
import { LOCAL_TOOL_NAMES } from "../../src/live/local/dispatch.js";

const bin = join(__dirname, "..", "..", "dist", "index.js");

const MUSTER_COMPANY_JSON = {
  name: "Suveren", owner: "Andreas Schadauer MUSTER",
  address: { street: "MUSTER-Straße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
  uid: "ATU00000000", email: "andreas@sublin.app", web: "www.suveren.ai", register: null,
  bank: { name: "MUSTER Bank", iban: "AT00", bic: "MUSTERBIC" },
  default_payment_term_days: 14, vat_mode: "normal",
};

let dataDir: string;
let client: Client;
let customerId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "erp-local-outputschema-"));
  writeFileSync(join(dataDir, "company.json"), JSON.stringify(MUSTER_COMPANY_JSON));

  // Seed a customer directly (the AI has no tool to create one — see customers.test.ts).
  const dbPath = join(dataDir, "erp-local.sqlite");
  const seedDb = await createLocalDb(dbPath);
  const customer = await addCustomer(seedDb, {
    name: "Drautal Maschinenbau GmbH",
    address_lines: ["Industriestraße 12", "9800 Spittal an der Drau", "Österreich"],
    country: "AT",
    uid: "ATU12345678",
    email: "buchhaltung@drautal.example",
  });
  customerId = customer.id;
  await seedDb.close();

  const transport = new StdioClientTransport({
    command: "node",
    args: [bin],
    env: {
      ...(process.env as Record<string, string>),
      ERP_MODE: "live",
      ERP_LIVE_ADAPTER: "local",
      ERP_LIVE_COMPANY_FILE: join(dataDir, "company.json"),
      HAP_DATA_DIR: dataDir,
    },
    stderr: "ignore",
  });
  client = new Client({ name: "local-output-schema-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
}, 20_000);

afterAll(async () => {
  await client.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

function invoiceArgs(number: string) {
  return {
    customer_id: customerId,
    number,
    document_date: todayInTimezone("Europe/Vienna"),
    service_period: { from: "2026-10-06", to: "2026-10-24" },
    lines: [{ description: "Beratung", qty: 1, unit_price: 100, vat_rate: 20 }],
    net_total: 100,
    currency: "EUR",
  };
}

describe("preview_invoice: outputSchema + structuredContent over the real stdio wire", () => {
  it("declares an outputSchema naming filename/sha256/pages as required", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "preview_invoice")!;
    expect(tool.outputSchema).toBeTruthy();
    const schema = tool.outputSchema as any;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("filename");
    expect(schema.required).toContain("sha256");
    expect(schema.required).toContain("pages");
  });

  it("a preview_invoice result carries structuredContent AND text content with the same data", async () => {
    const result: any = await client.callTool({ name: "preview_invoice", arguments: invoiceArgs("2026-9001") });
    expect(result.isError).toBeFalsy();

    const fromText = JSON.parse(result.content[0].text);
    expect(fromText.filename).toBe("invoice-2026-9001.pdf");
    expect(fromText.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(result.structuredContent).toBeTruthy();
    expect(result.structuredContent.filename).toBe(fromText.filename);
    expect(result.structuredContent.sha256).toBe(fromText.sha256);
    expect(result.structuredContent.pages).toBe(fromText.pages);
  });
});

describe("get_document: outputSchema + structuredContent over the real stdio wire", () => {
  it("declares an outputSchema naming filename/contentBase64/sha256 as required", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_document")!;
    expect(tool.outputSchema).toBeTruthy();
    const schema = tool.outputSchema as any;
    expect(schema.required).toContain("filename");
    expect(schema.required).toContain("contentBase64");
    expect(schema.required).toContain("sha256");
  });

  it("a get_document result carries structuredContent AND text content with the same data", async () => {
    const created: any = await client.callTool({ name: "create_invoice", arguments: invoiceArgs("2026-9002") });
    const invoice = JSON.parse(created.content[0].text);

    const result: any = await client.callTool({ name: "get_document", arguments: { kind: "invoice-pdf", id: invoice.id } });
    expect(result.isError).toBeFalsy();

    const fromText = JSON.parse(result.content[0].text);
    expect(fromText.sha256).toBe(invoice.archive_sha256);

    expect(result.structuredContent).toBeTruthy();
    expect(result.structuredContent.sha256).toBe(invoice.archive_sha256);
    expect(result.structuredContent.contentBase64).toBe(fromText.contentBase64);
  });
});

describe("other local tools carry no structuredContent — scoped to preview_invoice/get_document (+ get_invoice/get_credit_note)", () => {
  it("list_invoices declares no outputSchema and carries no structuredContent", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "list_invoices")!;
    expect(tool.outputSchema).toBeUndefined();

    const result: any = await client.callTool({ name: "list_invoices", arguments: {} });
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("registry and snapshot over the real stdio wire (A1)", () => {
  it("tools/list serves exactly the merged registry", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...LOCAL_TOOL_NAMES]);
  });

  it("get_invoice carries the customer snapshot in structuredContent and text", async () => {
    const created: any = await client.callTool({ name: "create_invoice", arguments: { ...invoiceArgs("2026-9003"), customer_revision: 1 } });
    expect(created.isError).toBeFalsy();
    const result: any = await client.callTool({ name: "get_invoice", arguments: { id: "2026-9003" } });
    const expected = {
      name: "Drautal Maschinenbau GmbH", address_lines: ["Industriestraße 12", "9800 Spittal an der Drau", "Österreich"],
      country: "AT", uid: "ATU12345678", revision: 1, source: "issued",
    };
    expect(JSON.parse(result.content[0].text).customer).toEqual(expected);
    expect(result.structuredContent.customer).toEqual(expected);
  });
});
