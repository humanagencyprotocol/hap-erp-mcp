/**
 * Review 2026-10-21 fixes, proven over the real stdio server (dist/index.js —
 * run `npm run build` first, as for mcp-output-schema.test.ts):
 *
 * - Finding 1: writes in flight at once used to break each other ("cannot
 *   start a transaction within a transaction"), leaving the loser's PDF in the
 *   archive with no row (burned number). The reviewer's probe — 20 rounds of
 *   parallel pairs — must now run with 0 failures and PDFs == documents.
 * - Structured results (gateway PR #149): every tool that declares an
 *   outputSchema answers with structuredContent that the MCP client accepts
 *   (the SDK client validates it against the schema).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from "fs";
import { todayInTimezone } from "../../src/live/local/date.js";

const bin = join(__dirname, "..", "..", "dist", "index.js");
const TODAY = todayInTimezone("Europe/Vienna");
const YEAR = TODAY.slice(0, 4);

const MUSTER_COMPANY_JSON = {
  name: "Suveren", owner: "Andreas Schadauer MUSTER",
  address: { street: "MUSTER-Straße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
  uid: "ATU00000000", email: "andreas@sublin.app", web: "www.suveren.ai", register: null,
  bank: { name: "MUSTER Bank", iban: "AT00", bic: "MUSTERBIC" },
  default_payment_term_days: 14, vat_mode: "normal",
};

let dataDir: string;
let client: Client;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "erp-local-review-stdio-"));
  writeFileSync(join(dataDir, "company.json"), JSON.stringify(MUSTER_COMPANY_JSON));
  const transport = new StdioClientTransport({
    command: "node",
    args: [bin],
    env: {
      ...(process.env as Record<string, string>),
      ERP_MODE: "live",
      ERP_LIVE_ADAPTER: "local",
      ERP_LIVE_COMPANY_FILE: join(dataDir, "company.json"),
      HAP_DATA_DIR: dataDir,
      ERP_VIES: "off",
    },
    stderr: "ignore",
  });
  client = new Client({ name: "review-fixes-stdio-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await client.listTools(); // the client validates structuredContent against the listed outputSchemas
}, 20_000);

afterAll(async () => {
  await client.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args });
  return r;
}
const ok = (r: any) => !r.isError;
const body = (r: any) => JSON.parse(r.content[0].text);

const pdfs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".pdf")) : []);

describe("finding 1: 20 rounds of parallel write pairs over stdio", () => {
  it("0 failures; archive PDFs == documents; quotes keep revising", async () => {
    const customer = body(await call("create_customer", { name: "Drautal", address_lines: ["Wien"], country: "AT" }));
    const L = [{ description: "x", qty: 1, unit_price: 100, vat_rate: 20 }];
    const quote = body(await call("create_quote", {
      customer_id: customer.id, number: "Q-RACE", document_date: TODAY, lines: L, value: 100, discount_pct: 0, currency: "EUR",
    }));
    const inv = (n: string) => ({
      customer_id: customer.id, number: n, document_date: TODAY, service_period: { from: TODAY, to: TODAY },
      currency: "EUR", lines: L, net_total: 100,
    });

    const failures: string[] = [];
    const note = (label: string, r: any) => { if (!ok(r)) failures.push(`${label}: ${r.content[0].text}`); };
    let customerRev = customer.revision;
    let quoteRev = quote.revision;
    for (let t = 0; t < 20; t++) {
      const [u, it1] = await Promise.all([
        call("update_customer", { id: customer.id, revision: customerRev, email: `e${t}@x.example` }),
        call("create_item", { name: `I${t}`, kind: "service", unit: "Std.", list_price: 1, vat_rate: 20 }),
      ]);
      note("update_customer", u); note("create_item", it1);
      if (ok(u)) customerRev++;
      const [q, i2] = await Promise.all([
        call("update_quote", {
          id: quote.id, revision: quoteRev, document_date: TODAY, value: 100, discount_pct: 0, currency: "EUR", notes: `n${t}`,
        }),
        call("create_invoice", inv(`C-${t}`)),
      ]);
      note("update_quote", q); note("create_invoice C", i2);
      if (ok(q)) quoteRev++;
      const [a, b] = await Promise.all([call("create_invoice", inv(`A-${t}`)), call("create_invoice", inv(`B-${t}`))]);
      note("invoice A", a); note("invoice B", b);
    }
    expect(failures).toEqual([]);

    const invoices = body(await call("list_invoices", { limit: 500 }));
    expect(invoices).toHaveLength(60);
    expect(pdfs(join(dataDir, "erp-local-archive", YEAR)).sort()).toEqual(invoices.map((i: any) => `${i.number}.pdf`).sort());
    expect(quoteRev).toBe(21);
    expect(pdfs(join(dataDir, "erp-local-archive", "quotes", YEAR))).toHaveLength(21);
  }, 60_000);
});

describe("structured results: outputSchema + structuredContent over stdio (gateway PR #149)", () => {
  async function structured(name: string, args: Record<string, unknown>) {
    const r = await call(name, args);
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    expect(r.structuredContent).toBeTruthy();
    expect(r.structuredContent).toEqual(body(r));
    return r.structuredContent;
  }

  it("every tool listed with an outputSchema answers with structuredContent", async () => {
    const { tools } = await client.listTools();
    const withSchema = tools.filter((t) => t.outputSchema).map((t) => t.name);
    for (const name of [
      "get_customer", "create_customer", "update_customer", "update_customer_tax_data", "check_vat_id",
      "preview_customer_change", "check_customer_duplicates", "get_item", "create_item", "update_item",
      "update_item_price", "preview_quote", "preview_invoice", "get_document",
    ]) {
      expect(withSchema, name).toContain(name);
    }

    const c = await structured("create_customer", {
      name: "Kessler GmbH", address_lines: ["Hamburg"], country: "DE", uid: "DE123456789", crm_contact_id: "crm-7",
    });
    await structured("get_customer", { id: c.id });
    await structured("check_vat_id", { country: "DE", uid: "DE 123 456 789" });
    await structured("preview_customer_change", { id: c.id, name: "Kessler AG", address_lines: ["Hamburg"], country: "DE", uid: "DE123456789" });
    expect(await structured("check_customer_duplicates", { uid: "de123.456.789", crm_contact_id: " CRM-7 " })).toEqual({
      uid: "DE123456789", crm_contact_id: "crm-7", vat_duplicate_of: c.id, crm_contact_duplicate_of: c.id,
    });

    const item = await structured("create_item", { name: "Beratung", kind: "service", unit: "Std.", list_price: 120, vat_rate: 20 });
    await structured("get_item", { id: item.id });
    await structured("update_item_price", { id: item.id, revision: 1, list_price: 130, vat_rate: 20 });
    await structured("get_item", { id: item.id, revision: 1 });

    const at = body(await call("create_customer", { name: "Huber", address_lines: ["Linz"], country: "AT" }));
    const p = await structured("preview_quote", {
      customer_id: at.id, number: "Q-PREVIEW", document_date: TODAY, value: 100, discount_pct: 0, currency: "EUR",
      lines: [{ description: "x", qty: 1, unit_price: 100, vat_rate: 20 }],
    });
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("list tools (arrays) still carry no structuredContent", async () => {
    const r = await call("list_items", {});
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toBeUndefined();
  });
});
