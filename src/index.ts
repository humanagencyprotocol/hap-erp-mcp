#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { list_items, get_item } from "./tools/items.js";
import { find_customers, get_customer } from "./tools/customers.js";
import { create_quote, update_quote, send_quote, list_quotes, get_quote } from "./tools/quotes.js";
import { convert_quote_to_order, list_orders, get_order } from "./tools/orders.js";

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
] as const;

type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

async function main() {
  const db = await createDb();

  const server = new Server(
    { name: "erp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, any>;

    try {
      let result: unknown;

      switch (name as ToolName) {
        case "list_items":
          result = await list_items(db, safeArgs);
          break;
        case "get_item":
          result = await get_item(db, safeArgs);
          break;
        case "find_customers":
          result = await find_customers(db, safeArgs);
          break;
        case "get_customer":
          result = await get_customer(db, safeArgs);
          break;
        case "list_quotes":
          result = await list_quotes(db, safeArgs);
          break;
        case "get_quote":
          result = await get_quote(db, safeArgs);
          break;
        case "list_orders":
          result = await list_orders(db, safeArgs);
          break;
        case "get_order":
          result = await get_order(db, safeArgs);
          break;
        case "create_quote":
          result = await create_quote(db, safeArgs);
          break;
        case "update_quote":
          result = await update_quote(db, safeArgs);
          break;
        case "send_quote":
          result = await send_quote(db, safeArgs);
          break;
        case "convert_quote_to_order":
          result = await convert_quote_to_order(db, safeArgs);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

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
