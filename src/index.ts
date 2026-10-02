#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { callTool } from "./dispatch.js";
import { getMode } from "./mode.js";
import { runCli } from "./cli.js";

const RECEIPT_FIELD = {
  type: "string" as const,
  description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this.",
};

const LINE_SCHEMA = {
  type: "object" as const,
  properties: {
    item_id: { type: "string", description: "Item ID" },
    qty: { type: "number", description: "Quantity (positive integer)" },
  },
  required: ["item_id", "qty"],
};

const TOOL_DEFINITIONS = [
  // --- Reads ---
  {
    name: "list_items",
    description: "List/search catalog items (sku, name, unit, list price, stock)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text search across sku and name" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_item",
    description: "Get a single item, including stock and list price",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Item ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "find_customers",
    description: "Search customers by name or email",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text search across name and email" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_customer",
    description: "Get a single customer, including credit limit, open balance, and available credit",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Customer ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_quotes",
    description: "List quotes, optionally filtered by status or customer",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "sent", "converted", "cancelled"], description: "Filter by status" },
        customer_id: { type: "string", description: "Filter by customer ID" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_quote",
    description: "Get a single quote with its lines",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_orders",
    description: "List orders, optionally filtered by customer",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Filter by customer ID" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_order",
    description: "Get a single order with its lines",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Order ID" },
      },
      required: ["id"],
    },
  },

  // --- Changes ---
  {
    name: "create_quote",
    description:
      "Create a draft quote for a customer. The connector recomputes the net total from the lines and the discount " +
      "and refuses the call if the declared value, discount, or currency does not match.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        lines: { type: "array", items: LINE_SCHEMA, description: "Quote lines" },
        discount_pct: { type: "number", description: "Document discount against list price, in percent (0-100)" },
        value: { type: "number", description: "Net document total — must equal sum(qty*list_price)*(1-discount_pct/100)" },
        currency: { type: "string", description: "Document currency — must match the customer's currency" },
        valid_until: { type: "string", description: "ISO 8601 date the quote is valid until (optional)" },
        notes: { type: "string", description: "Free-form notes (optional)" },
        receipt_id: RECEIPT_FIELD,
      },
      required: ["customer_id", "lines", "discount_pct", "value", "currency"],
    },
  },
  {
    name: "update_quote",
    description:
      "Update a draft quote (lines, discount, valid_until, notes). Only draft quotes can be updated. The connector " +
      "recomputes the net total and refuses the call if the declared value, discount, or currency does not match.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID" },
        lines: { type: "array", items: LINE_SCHEMA, description: "Replacement quote lines (optional — omit to keep existing lines)" },
        discount_pct: { type: "number", description: "Document discount against list price, in percent (0-100)" },
        value: { type: "number", description: "Net document total — must equal sum(qty*list_price)*(1-discount_pct/100)" },
        currency: { type: "string", description: "Document currency — must match the quote's currency" },
        valid_until: { type: "string", description: "ISO 8601 date the quote is valid until (optional)" },
        notes: { type: "string", description: "Free-form notes (optional)" },
        receipt_id: RECEIPT_FIELD,
      },
      required: ["id", "discount_pct", "value", "currency"],
    },
  },
  {
    name: "send_quote",
    description:
      "Send a draft quote to the customer (draft -> sent). Simulated: marks the quote sent and records sent_at. " +
      "The declared value, discount, and currency must match the quote as stored.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID" },
        value: { type: "number", description: "Net document total — must match the quote's stored net total" },
        discount_pct: { type: "number", description: "Must match the quote's stored discount — cannot change at send time" },
        currency: { type: "string", description: "Must match the quote's stored currency" },
        receipt_id: RECEIPT_FIELD,
      },
      required: ["id", "value", "discount_pct", "currency"],
    },
  },
  {
    name: "convert_quote_to_order",
    description:
      "Convert a sent quote into a confirmed order (sent -> order). Reserves stock for every line and refuses if the " +
      "customer's credit limit would be exceeded or any line lacks sufficient stock.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID" },
        value: { type: "number", description: "Net document total — must match the quote's stored net total" },
        discount_pct: { type: "number", description: "Must match the quote's stored discount — cannot change at conversion time" },
        currency: { type: "string", description: "Must match the quote's stored currency" },
        requested_delivery: { type: "string", description: "Requested delivery date (ISO 8601, optional)" },
        receipt_id: RECEIPT_FIELD,
      },
      required: ["id", "value", "discount_pct", "currency"],
    },
  },

  // --- Simulation setup ---
  {
    name: "load_simulation",
    description:
      "Simulation mode only: load a simulation package (name, currency, customers, products) into this connector's " +
      "simulated ERP. Create only — refused if test data was already loaded, or if any quote, order, or change " +
      "already exists. Replaces the auto-seeded demo catalog on the very first load. Not available in live mode.",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "object",
          description: "Simulation package: { name, currency, customers: [...], products: [...] } (accepts legacy `items` as an alias for `products`).",
        },
        receipt_id: RECEIPT_FIELD,
      },
      required: ["package"],
    },
  },
] as const;

async function main() {
  // `erp-mcp export` / `erp-mcp scenario …` are local operator commands, not MCP tools.
  if (process.argv.length > 2) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  const mode = getMode();
  const db = await createDb();
  console.error(`[erp-mcp] mode: ${mode}`);

  const server = new Server(
    { name: "erp", version: "0.3.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
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
