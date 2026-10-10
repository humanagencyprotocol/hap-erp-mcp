/**
 * get_quote's `revision` and `status` are meant to be read generically (e.g.
 * by a gateway rendering them without erp-specific code — a later feature,
 * tracked elsewhere). That needs an actual MCP `outputSchema` declaration
 * and `structuredContent` on the result, not just a JSON-shaped text blob —
 * and it needs proving over the real stdio wire this connector actually
 * speaks, not by calling the dispatch function directly (which never goes
 * through index.ts's response shaping at all). hap-e2e cannot prove this
 * either: the gateway's integration-manager only forwards `{content,
 * isError}` from a downstream tool today, so `structuredContent` would be
 * silently stripped there — this connector's own contract is the only place
 * that can still show it reaches the wire.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

const dbPath = join(tmpdir(), `erp-outputschema-${process.pid}-${Date.now()}.db`);
const bin = join(__dirname, "..", "dist", "index.js");
const companyFile = join(__dirname, "..", "examples", "company.example.json");

let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [bin],
    env: { ...(process.env as Record<string, string>), DATABASE_URL: dbPath, ERP_COMPANY_FILE: companyFile },
    stderr: "ignore",
  });
  client = new Client({ name: "output-schema-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
}, 20_000);

afterAll(async () => {
  await client.close().catch(() => {});
  rmSync(dbPath, { force: true });
  rmSync(dbPath.replace(/\.db$/, ".backup.db"), { force: true });
});

describe("get_quote: outputSchema + structuredContent over the real stdio wire", () => {
  it("declares an outputSchema naming revision and status as required, with human titles", async () => {
    const { tools } = await client.listTools();
    const getQuote = tools.find((t) => t.name === "get_quote")!;
    expect(getQuote.outputSchema).toBeTruthy();
    const schema = getQuote.outputSchema as any;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("revision");
    expect(schema.required).toContain("status");
    expect(schema.properties.revision.title).toBeTruthy();
    expect(schema.properties.status.title).toBeTruthy();
  });

  it("a get_quote result carries structuredContent AND text content with the same data", async () => {
    const customers = JSON.parse(
      (await client.callTool({ name: "find_customers", arguments: {} }) as any).content[0].text
    );
    const items = JSON.parse(
      (await client.callTool({ name: "list_items", arguments: {} }) as any).content[0].text
    );
    const created: any = await client.callTool({
      name: "create_quote",
      arguments: {
        customer_id: customers[0].id,
        lines: [{ item_id: items[0].id, qty: 1 }],
        discount_pct: 0,
        value: items[0].list_price,
        currency: customers[0].currency,
      },
    });
    const quote = JSON.parse(created.content[0].text);

    const result: any = await client.callTool({ name: "get_quote", arguments: { id: quote.id } });
    expect(result.isError).toBeFalsy();

    // Text content — for clients that ignore structuredContent.
    const fromText = JSON.parse(result.content[0].text);
    expect(fromText.revision).toBe(1);
    expect(fromText.status).toBe("draft");

    // structuredContent — the same data, structurally.
    expect(result.structuredContent).toBeTruthy();
    expect(result.structuredContent.revision).toBe(1);
    expect(result.structuredContent.status).toBe("draft");
    expect(result.structuredContent.id).toBe(quote.id);
  });

  it("other tools (e.g. list_items) declare no outputSchema and carry no structuredContent — scoped to get_quote only", async () => {
    const { tools } = await client.listTools();
    const listItems = tools.find((t) => t.name === "list_items")!;
    expect(listItems.outputSchema).toBeUndefined();

    const result: any = await client.callTool({ name: "list_items", arguments: {} });
    expect(result.structuredContent).toBeUndefined();
  });
});
