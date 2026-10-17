/** The MCP tool surface for live mode's "local" adapter — kept separate from the simulation's surface. */
const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};

const LOCAL_LINE_SCHEMA = {
  type: "object" as const,
  properties: {
    description: { type: "string", description: "Line description" },
    qty: { type: "number", description: "Quantity (positive)" },
    unit: { type: "string", description: "Unit label (optional, default \"Stk.\")" },
    unit_price: { type: "number", description: "Net unit price in EUR" },
    vat_rate: { type: "number", description: "VAT rate in percent, e.g. 20 for 20%" },
  },
  required: ["description", "qty", "unit_price", "vat_rate"],
};

const SERVICE_PERIOD_SCHEMA = {
  type: "object" as const,
  properties: {
    from: { type: "string", description: "ISO 8601 date the service period starts" },
    to: { type: "string", description: "ISO 8601 date the service period ends" },
  },
  required: ["from", "to"],
};

export const LOCAL_TOOL_DEFINITIONS = [
  {
    name: "find_customers",
    description: "Search this company's own customers by name or email",
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
    description: "Get a single customer (name, address, country, UID, email)",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Customer ID" } },
      required: ["id"],
    },
  },
  {
    name: "create_invoice",
    description:
      "Issue a real invoice. `number` is required — it comes with the request; this connector refuses a number " +
      "already used (invoices and credit notes share one numbering namespace) but never generates one itself. " +
      "The connector recomputes the net total from the lines and refuses the call if the declared net_total or " +
      "currency does not match. Tax mode (normal / reverse charge / exempt) is derived automatically from the " +
      "customer's country and UID and the company's own VAT setting; reverse charge without a customer UID, and " +
      "any gross total above €10,000 without a customer UID, are refused outright.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        number: { type: "string", description: "Invoice number — required, comes with the request" },
        service_period: SERVICE_PERIOD_SCHEMA,
        lines: { type: "array", items: LOCAL_LINE_SCHEMA, description: "Invoice lines (required)" },
        net_total: { type: "number", description: "Declared net total — must equal sum(qty*unit_price) over the lines" },
        currency: { type: "string", description: "Must be EUR" },
        payment_term_days: { type: "number", description: "Days until due, from issue (optional, defaults to the company's own setting)" },
        memo: { type: "string", description: "Free-form note (optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["customer_id", "number", "service_period", "lines", "net_total", "currency"],
    },
  },
  {
    name: "preview_invoice",
    description:
      "Render the invoice PDF exactly as create_invoice would, WITHOUT issuing it — no number is consumed, " +
      "nothing is archived, nothing is recorded. Same arguments as create_invoice.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        number: { type: "string", description: "Invoice number as it would appear on the rendered PDF" },
        service_period: SERVICE_PERIOD_SCHEMA,
        lines: { type: "array", items: LOCAL_LINE_SCHEMA, description: "Invoice lines (required)" },
        net_total: { type: "number", description: "Declared net total — must equal sum(qty*unit_price) over the lines" },
        currency: { type: "string", description: "Must be EUR" },
        payment_term_days: { type: "number", description: "Days until due, from issue (optional)" },
        memo: { type: "string", description: "Free-form note (optional)" },
      },
      required: ["customer_id", "number", "service_period", "lines", "net_total", "currency"],
    },
  },
  {
    name: "create_credit_note",
    description:
      "Issue a credit note against an issued invoice — the only way to cancel or correct one. `number` is " +
      "required (same shared namespace as invoices). Pass explicit lines for a partial credit; omit lines to " +
      "credit everything on the invoice not yet credited.",
    inputSchema: {
      type: "object",
      properties: {
        invoice_id: { type: "string", description: "Invoice ID or number" },
        number: { type: "string", description: "Credit note number — required, comes with the request" },
        credit_total: { type: "number", description: "Declared net credit total" },
        currency: { type: "string", description: "Must match the invoice's currency" },
        reason: { type: "string", description: "Why this credit note is being issued" },
        service_period: { ...SERVICE_PERIOD_SCHEMA, description: "Optional — defaults to the invoice's own service period" },
        lines: { type: "array", items: LOCAL_LINE_SCHEMA, description: "Explicit credit lines for a partial credit (optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["invoice_id", "number", "credit_total", "currency", "reason"],
    },
  },
  {
    name: "get_invoice",
    description: "Get a single invoice with its lines. Accepts the invoice ID or its number.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Invoice ID or number" } },
      required: ["id"],
    },
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
      properties: { id: { type: "string", description: "Credit note ID or number" } },
      required: ["id"],
    },
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
  {
    name: "get_document",
    description:
      "Read an issued invoice or credit note PDF from the archive. Verifies the file's sha256 against the " +
      "fingerprint stored at issue time and refuses to return it if they no longer match.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["invoice-pdf", "credit-note-pdf"], description: "Which document to read" },
        id: { type: "string", description: "Invoice or credit note ID (or number)" },
      },
      required: ["kind", "id"],
    },
  },
] as const;
