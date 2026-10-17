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

const INVOICE_LINE_SCHEMA = {
  type: "object" as const,
  properties: {
    item_id: { type: "string", description: "Item ID (optional)" },
    description: { type: "string", description: "Line description" },
    qty: { type: "number", description: "Quantity (positive)" },
    unit_price: { type: "number", description: "Net unit price in the document currency" },
    vat_rate: { type: "number", description: "VAT rate in percent, e.g. 20 for 20%" },
  },
  required: ["description", "qty", "unit_price", "vat_rate"],
};

const INVOICE_OUTPUT_SCHEMA = {
  type: "object",
  title: "Invoice",
  properties: {
    id: { type: "string", title: "Invoice ID" },
    number: { type: "string", title: "Invoice number" },
    customer_id: { type: "string", title: "Customer ID" },
    order_id: { type: ["string", "null"], title: "Order ID" },
    status: {
      type: "string", title: "Status", enum: ["issued", "partially_credited", "credited"],
      description: "An issued invoice is never changed or deleted — only credit notes move it to partially_credited or credited.",
    },
    currency: { type: "string", title: "Currency" },
    net_total: { type: "number", title: "Net total" },
    vat_total: { type: "number", title: "VAT total" },
    gross_total: { type: "number", title: "Gross total" },
    credited_total: { type: "number", title: "Credited so far", description: "Net amount credited back via credit notes." },
    payment_term_days: { type: "number", title: "Payment term (days)" },
    issued_at: { type: "string", title: "Issued at" },
    due_date: { type: "string", title: "Due date" },
    memo: { type: ["string", "null"], title: "Memo" },
    lines: {
      type: "array", title: "Lines",
      items: {
        type: "object",
        properties: {
          item_id: { type: ["string", "null"], title: "Item ID" },
          description: { type: "string", title: "Description" },
          qty: { type: "number", title: "Quantity" },
          unit_price: { type: "number", title: "Unit price" },
          vat_rate: { type: "number", title: "VAT rate (%)" },
          line_net: { type: "number", title: "Line net" },
          line_vat: { type: "number", title: "Line VAT" },
          line_gross: { type: "number", title: "Line gross" },
        },
      },
    },
  },
  required: ["id", "number", "status", "currency", "net_total", "vat_total", "gross_total", "credited_total", "issued_at", "due_date", "lines"],
};

const CREDIT_NOTE_OUTPUT_SCHEMA = {
  type: "object",
  title: "Credit note",
  properties: {
    id: { type: "string", title: "Credit note ID" },
    number: { type: "string", title: "Credit note number" },
    invoice_id: { type: "string", title: "Invoice ID" },
    invoice_number: { type: "string", title: "Invoice number" },
    customer_id: { type: "string", title: "Customer ID" },
    currency: { type: "string", title: "Currency" },
    net_total: { type: "number", title: "Net total" },
    vat_total: { type: "number", title: "VAT total" },
    gross_total: { type: "number", title: "Gross total" },
    reason: { type: "string", title: "Reason" },
    issued_at: { type: "string", title: "Issued at" },
    lines: {
      type: "array", title: "Lines",
      items: {
        type: "object",
        properties: {
          item_id: { type: ["string", "null"], title: "Item ID" },
          description: { type: "string", title: "Description" },
          qty: { type: "number", title: "Quantity" },
          unit_price: { type: "number", title: "Unit price" },
          vat_rate: { type: "number", title: "VAT rate (%)" },
          line_net: { type: "number", title: "Line net" },
          line_vat: { type: "number", title: "Line VAT" },
          line_gross: { type: "number", title: "Line gross" },
        },
      },
    },
  },
  required: ["id", "number", "invoice_id", "invoice_number", "customer_id", "currency", "net_total", "vat_total", "gross_total", "reason", "issued_at", "lines"],
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
  {
    name: "get_invoice",
    description: "Get a single invoice with its lines. Accepts the invoice ID or its number (e.g. INV-2026-0001).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Invoice ID or number" },
      },
      required: ["id"],
    },
    outputSchema: INVOICE_OUTPUT_SCHEMA,
  },
  {
    name: "list_invoices",
    description: "List invoices, optionally filtered by customer or status",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Filter by customer ID" },
        status: { type: "string", enum: ["issued", "partially_credited", "credited"], description: "Filter by status" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_credit_note",
    description: "Get a single credit note with its lines",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Credit note ID" },
      },
      required: ["id"],
    },
    outputSchema: CREDIT_NOTE_OUTPUT_SCHEMA,
  },
  {
    name: "list_credit_notes",
    description: "List credit notes, optionally filtered by invoice or customer",
    inputSchema: {
      type: "object",
      properties: {
        invoice_id: { type: "string", description: "Filter by invoice ID" },
        customer_id: { type: "string", description: "Filter by customer ID" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
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

  {
    name: "create_invoice",
    description:
      "Issue an invoice for a customer, from an order's lines or from explicit lines. An issued invoice is never " +
      "changed or deleted — a cancellation or correction is create_credit_note. With order_id and no lines, the " +
      "invoice's lines are taken from that order (its items, quantities, and the net prices it was ordered at); " +
      "with explicit lines, each one declares its own description, quantity, unit price, and VAT rate. The " +
      "connector recomputes the net total from the lines and refuses the call if the declared net_total, currency, " +
      "or an order's ownership does not match. Refused if the order already carries an invoice that is not fully " +
      "credited.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        order_id: { type: "string", description: "Order ID to invoice (optional if lines is given)" },
        lines: { type: "array", items: INVOICE_LINE_SCHEMA, description: "Explicit invoice lines (optional — omit to take lines from order_id)" },
        net_total: { type: "number", description: "Declared net total — must equal sum(qty*unit_price) over the lines" },
        currency: { type: "string", description: "Document currency — must match the order's currency, or the customer's if there is no order" },
        payment_term_days: { type: "number", description: "Days until due, from issue (optional, default 14)" },
        memo: { type: "string", description: "Free-form note (optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["customer_id", "net_total", "currency"],
    },
  },
  {
    name: "create_credit_note",
    description:
      "Issue a credit note against an issued invoice — the only way to cancel or correct one; the invoice itself " +
      "is never changed or deleted. Accepts the invoice's ID or its number. Pass explicit lines for a partial " +
      "credit (each declaring its own description, quantity, unit price, and VAT rate); omit lines to credit " +
      "everything on the invoice not yet credited. The connector recomputes the net total from the lines (or the " +
      "remaining amount) and refuses the call if the declared credit_total or currency does not match, or if the " +
      "credit would exceed what is left to credit on the invoice. On success the invoice's credited_total grows " +
      "and its status becomes partially_credited or credited.",
    inputSchema: {
      type: "object",
      properties: {
        invoice_id: { type: "string", description: "Invoice ID or number" },
        credit_total: { type: "number", description: "Declared net credit total — must equal sum(qty*unit_price) over the lines, or the remaining uncredited net total when lines is omitted" },
        currency: { type: "string", description: "Must match the invoice's currency" },
        reason: { type: "string", description: "Why this credit note is being issued" },
        lines: { type: "array", items: INVOICE_LINE_SCHEMA, description: "Explicit credit lines for a partial credit (optional — omit to credit everything not yet credited)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["invoice_id", "credit_total", "currency", "reason"],
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
