/** The MCP tool surface — kept in its own module so tests can read it without starting the server. */
import { SIMULATION_PACKAGE_SCHEMA } from "../simulation-package-schema.js";
import { SIMULATION_PACKAGE_GUIDE } from "../simulation-package-guide.js";
const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};

const LINE_SCHEMA = {
  type: "object" as const,
  properties: {
    item_id: { type: "string", description: "Item ID" },
    qty: { type: "number", description: "Quantity (positive integer)" },
  },
  required: ["item_id", "qty"],
};

export const TOOL_DEFINITIONS = [
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
    description: "List quotes, optionally filtered by status or customer. Each result includes its current revision.",
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
    description:
      "Get a single quote with its lines, including its current revision. Pass `revision` to get an earlier " +
      "revision's content instead (status and timestamps still reflect the quote as it is now).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID" },
        revision: { type: "number", description: "Optional — return this past revision's content instead of the current one" },
      },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      title: "Quote",
      properties: {
        id: { type: "string", title: "Quote ID" },
        number: { type: "string", title: "Quote number" },
        customer_id: { type: "string", title: "Customer ID" },
        status: {
          type: "string", title: "Status", enum: ["draft", "sent", "converted", "cancelled"],
          description: "Where this quote is in its lifecycle. Reflects the quote as it is now, even when `revision` named an earlier version.",
        },
        currency: { type: "string", title: "Currency" },
        discount_pct: { type: "number", title: "Discount (%)" },
        net_total: { type: "number", title: "Net total" },
        valid_until: { type: ["string", "null"], title: "Valid until" },
        notes: { type: ["string", "null"], title: "Notes" },
        created_at: { type: "string", title: "Created at" },
        updated_at: { type: "string", title: "Updated at" },
        sent_at: { type: ["string", "null"], title: "Sent at" },
        revision: {
          type: "number", title: "Revision",
          description: "Integer version of this quote's content. send_quote and convert_quote_to_order must name this exact number.",
        },
        lines: {
          type: "array", title: "Lines",
          items: {
            type: "object",
            properties: {
              item_id: { type: "string", title: "Item ID" },
              qty: { type: "number", title: "Quantity" },
              list_price: { type: "number", title: "List price" },
              line_total: { type: "number", title: "Line total" },
            },
          },
        },
      },
      required: ["id", "number", "status", "currency", "discount_pct", "net_total", "revision", "lines"],
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
      "and refuses the call if the declared value, discount, or currency does not match. The result's `revision` " +
      "is always 1 — sending or converting this quote later will require it.",
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
        ticket_id: TICKET_FIELD,
      },
      required: ["customer_id", "lines", "discount_pct", "value", "currency"],
    },
  },
  {
    name: "update_quote",
    description:
      "Update a draft quote (lines, discount, valid_until, notes). Only draft quotes can be updated. The connector " +
      "recomputes the net total and refuses the call if the declared value, discount, or currency does not match. " +
      "Every successful update produces the next revision (the result's `revision` field) — sending or converting " +
      "this quote will require that new number, not the one it had before this call.",
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
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "discount_pct", "value", "currency"],
    },
  },
  {
    name: "send_quote",
    description:
      "Send a draft quote to the customer (draft -> sent); records when it was sent. " +
      "The declared value, discount, and currency must match the quote as stored. `revision` must match the " +
      "quote's current revision (from create_quote, update_quote, or get_quote) — refused if the quote was " +
      "changed since that revision was read, naming both revisions; nothing is sent on a refusal.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID" },
        value: { type: "number", description: "Net document total — must match the quote's stored net total" },
        discount_pct: { type: "number", description: "Must match the quote's stored discount — cannot change at send time" },
        currency: { type: "string", description: "Must match the quote's stored currency" },
        revision: { type: "number", description: "The quote's current revision — refused if the quote has moved on to a later one" },
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "value", "discount_pct", "currency", "revision"],
    },
  },
  {
    name: "convert_quote_to_order",
    description:
      "Convert a sent quote into a confirmed order (sent -> order). Reserves stock for every line and refuses if the " +
      "customer's credit limit would be exceeded or any line lacks sufficient stock. `revision` must match the " +
      "quote's current revision (from create_quote, update_quote, or get_quote) — refused if the quote was " +
      "changed since that revision was read, naming both revisions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID" },
        value: { type: "number", description: "Net document total — must match the quote's stored net total" },
        discount_pct: { type: "number", description: "Must match the quote's stored discount — cannot change at conversion time" },
        currency: { type: "string", description: "Must match the quote's stored currency" },
        revision: { type: "number", description: "The quote's current revision — refused if the quote has moved on to a later one" },
        requested_delivery: { type: "string", description: "Requested delivery date (ISO 8601, optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "value", "discount_pct", "currency", "revision"],
    },
  },

  // --- Simulation setup ---
  {
    name: "load_simulation",
    description:
      "Simulation mode only: load a simulation package (name, currency, customers, products) into this connector's " +
      "simulated ERP. Create only — refused if test data was already loaded, or if any customer, product, quote, " +
      "order, or change already exists; clear_simulation empties it first. Not available in live mode. " + SIMULATION_PACKAGE_GUIDE,
    inputSchema: {
      type: "object",
      properties: {
        package: { ...SIMULATION_PACKAGE_SCHEMA, description: `${SIMULATION_PACKAGE_SCHEMA.description} This connector loads \`name\`, \`currency\`, \`customers\` and \`products\` (legacy \`items\` accepted as an alias); \`cases\` and \`contacts\` are used by the email simulator and the CRM.` },
        ticket_id: TICKET_FIELD,
      },
      required: ["package"],
    },
  },
  {
    name: "clear_simulation",
    description:
      "Simulation mode only: delete all test data from this connector's simulated ERP — customers, products, quotes, " +
      "orders, and the record of changes and refusals — so a new package can be loaded with load_simulation. " +
      "Cannot be undone. Not available in live mode.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: TICKET_FIELD,
      },
      required: [],
    },
  },
] as const;
