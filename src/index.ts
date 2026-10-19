#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { callTool } from "./dispatch.js";
import { getMode, getLiveAdapter } from "./mode.js";
import { runCli } from "./cli.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { LOCAL_TOOL_DEFINITIONS } from "./live/local/definitions.js";
import { createLocalDb, resolveLocalDbPath } from "./live/local/db.js";



async function main() {
  // `erp-mcp export` / `erp-mcp scenario …` / `erp-mcp customers …` are local
  // operator commands, not MCP tools.
  if (process.argv.length > 2) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  const mode = getMode();
  const adapter = mode === "live" ? getLiveAdapter() : undefined;
  const usingLocalAdapter = mode === "live" && adapter === "local";

  const db = usingLocalAdapter ? await createLocalDb(resolveLocalDbPath()) : await createDb();
  console.error(`[erp-mcp] mode: ${mode}${adapter ? ` (adapter: ${adapter})` : ""}`);

  const server = new Server(
    { name: "erp", version: "0.3.3" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: usingLocalAdapter ? LOCAL_TOOL_DEFINITIONS : TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, any>;

    try {
      const result = await callTool(db, mode, name, safeArgs);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        // get_quote, get_invoice, get_credit_note (their status/lifecycle
        // fields are meant to be read generically, e.g. by a gateway
        // rendering them without erp-specific code), get_document (simulation
        // and live/local) and preview_invoice (live/local) (so the gateway can actually read
        // the rendered/archived PDF — see live/local/definitions.ts) all
        // declare an outputSchema; structuredContent carries the same object
        // for clients that use it, the text content above still carries it
        // for clients that don't.
        ...(["get_quote", "get_invoice", "get_credit_note", "get_document", "preview_invoice"].includes(name)
          ? { structuredContent: result as Record<string, unknown> }
          : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[erp-mcp] tool error (${name}):`, message);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  process.on("SIGINT", async () => {
    await db.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[erp-mcp] server started");
}

main().catch((err) => {
  console.error("[erp-mcp] fatal:", err);
  process.exit(1);
});
