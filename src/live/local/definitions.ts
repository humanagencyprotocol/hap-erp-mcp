/**
 * The MCP tool surface for live mode's "local" adapter — kept separate from
 * the simulation's surface. A registry: each area (core invoicing +
 * customers here, quotes in definitions-quotes.ts, catalogue items in
 * definitions-items.ts) owns its own list; LOCAL_TOOL_DEFINITIONS merges
 * them, and dispatch.ts merges the matching handlers
 * (docs/local-production-contract.md §9).
 */
import { QUOTE_TOOL_DEFINITIONS } from "./definitions-quotes.js";
import { ITEM_TOOL_DEFINITIONS, LINE_ITEM_ID_FIELD, LINE_ITEM_REVISION_FIELD } from "./definitions-items.js";

export interface LocalToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: readonly string[] };
  outputSchema?: Record<string, unknown>;
}

const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};

const LOCAL_LINE_SCHEMA = {
  type: "object" as const,
  properties: {
    item_id: LINE_ITEM_ID_FIELD,
    item_revision: LINE_ITEM_REVISION_FIELD,
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

// One consistent field name on every document-producing tool (Andreas,
// 2026-10-18): the date comes WITH the request, never "now" — see
// tools/invoices.ts and date.ts.
const DOCUMENT_DATE_FIELD = {
  type: "string" as const,
  description:
    "The document's date (ISO \"YYYY-MM-DD\"), printed on it and used to compute the due date. Required. " +
    "create_invoice and create_credit_note refuse a date that is not today in the company's own calendar " +
    "(see the company file's timezone, default Europe/Vienna) — propose the call again with today's date.",
};

// Optional on create_invoice / preview_invoice (contract §3.6): the governing
// layer passes the customer revision the approval was shown, so a customer
// change between approval and execution refuses instead of issuing.
const CUSTOMER_REVISION_FIELD = {
  type: "number" as const,
  description:
    "Revision of the customer this request was prepared for (optional). If given and the customer has " +
    "changed since, the call is refused naming both revisions.",
};

const PREVIEW_DOCUMENT_DATE_FIELD = {
  type: "string" as const,
  description:
    "The document's date (ISO \"YYYY-MM-DD\") as it would be printed. Required, but unlike create_invoice this " +
    "accepts any date — a preview may show the document as it would print on a past, present, or future date.",
};

export const DOCUMENT_OUTPUT_SCHEMA = {
  type: "object",
  title: "Document",
  properties: {
    filename: { type: "string", title: "Filename" },
    contentType: { type: "string", title: "Content type" },
    contentBase64: { type: "string", title: "Content (base64)" },
    sha256: { type: "string", title: "SHA-256 fingerprint", description: "Of the raw PDF bytes — matches the archived fingerprint for an issued document." },
  },
  required: ["filename", "contentType", "contentBase64", "sha256"],
};

const PREVIEW_INVOICE_OUTPUT_SCHEMA = {
  type: "object",
  title: "Invoice preview",
  properties: {
    ...DOCUMENT_OUTPUT_SCHEMA.properties,
    pages: { type: "number", title: "Pages" },
  },
  required: [...DOCUMENT_OUTPUT_SCHEMA.required, "pages"],
};

// Customers (docs/local-production-contract.md §3). Writes are each their own
// decision: contact data, tax data (name, address, country, VAT ID) and new
// customers. check_vat_id / preview_customer_change are card-only reads.
const CUSTOMER_ADDRESS_FIELD = {
  type: "array" as const,
  items: { type: "string" },
  description: "Address lines printed under the name (street, zip + city, …) — at least one",
};
const COUNTRY_FIELD = { type: "string" as const, description: "ISO 3166-1 alpha-2 country code, e.g. AT" };
const REVISION_FIELD = {
  type: "number" as const,
  description: "The customer's current revision (from get_customer) — the change is refused if the customer has changed since.",
};
const VIES_NOTE =
  "A VAT ID of an EU member state (or XI, Northern Ireland) is checked online against the European Commission's VIES " +
  "service when saved — this sends the customer's country and VAT ID, and the company's own VAT ID, to ec.europa.eu. " +
  "A VAT ID VIES reports as not valid is refused; if VIES is unreachable the customer is saved with the VAT ID marked " +
  "not checked.";

const CUSTOMER_TOOL_DEFINITIONS = [
  {
    name: "find_customers",
    description:
      "Search this company's own customers by name or email, or find one exactly by VAT ID (`uid`) or CRM contact " +
      "(`crm_contact_id`) — check this before create_customer: a VAT ID or CRM contact can belong to only one customer. " +
      "Each result carries `tax_mode`, `tax_mode_label` and `vies_status` as get_customer does.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text search across name and email" },
        uid: { type: "string", description: "Exact VAT ID (spaces, dots and dashes are ignored)" },
        crm_contact_id: { type: "string", description: "Exact CRM contact id" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_customer",
    description:
      "Get a single customer (name, address, country, VAT ID, email, CRM contact, revision, last VIES check as " +
      "`vies` and `vies_status`), plus `tax_mode` / `tax_mode_label`: the tax treatment a new invoice to this customer " +
      "would get now. A reverse-charge invoice is issued only if `vies_status` is \"valid\". " +
      "With `revision`, returns that older revision's content (no VIES result is kept for old revisions).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Customer ID" },
        revision: { type: "number", description: "An older revision to read (optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_customer",
    description:
      "Create a customer (revision 1). Refused if another customer already has the same VAT ID or CRM contact — " +
      "the refusal names it. " + VIES_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Customer name as printed on invoices" },
        address_lines: CUSTOMER_ADDRESS_FIELD,
        country: COUNTRY_FIELD,
        uid: { type: "string", description: "VAT ID (optional), e.g. ATU12345678" },
        email: { type: "string", description: "Email (optional)" },
        crm_contact_id: { type: "string", description: "The CRM contact this customer is made from (optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["name", "address_lines", "country"],
    },
  },
  {
    name: "update_customer",
    description:
      "Change a customer's contact data — email and/or CRM contact (null removes it). Name, address, country and " +
      "VAT ID are tax data and are refused here: use update_customer_tax_data.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Customer ID" },
        revision: REVISION_FIELD,
        email: { type: ["string", "null"], description: "New email, or null to remove" },
        crm_contact_id: { type: ["string", "null"], description: "New CRM contact id, or null to remove" },
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision"],
    },
  },
  {
    name: "update_customer_tax_data",
    description:
      "Replace a customer's tax data — name, address, country and VAT ID, all four required (uid: null removes the " +
      "VAT ID). Invoices and credit notes already issued keep the data they were issued with. Submitting the same " +
      "data again is refused, except for an EU VAT ID not yet confirmed by VIES: that re-runs the check. " + VIES_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Customer ID" },
        revision: REVISION_FIELD,
        name: { type: "string", description: "Customer name as printed on invoices" },
        address_lines: CUSTOMER_ADDRESS_FIELD,
        country: COUNTRY_FIELD,
        uid: { type: ["string", "null"], description: "VAT ID, or null for none" },
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "name", "address_lines", "country", "uid"],
    },
  },
  {
    name: "check_vat_id",
    description:
      "Check a VAT ID without saving anything: format, the online VIES answer (asks ec.europa.eu, at most 4 s) and " +
      "whether another customer already has it.",
    inputSchema: {
      type: "object",
      properties: { country: COUNTRY_FIELD, uid: { type: "string", description: "VAT ID" } },
      required: ["country", "uid"],
    },
  },
  {
    name: "preview_customer_change",
    description:
      "Show what update_customer_tax_data would change, without saving: changed fields, the tax treatment of future " +
      "invoices before and after, documents already issued (they keep the old data), open quotes, and the VAT-ID check " +
      "(asks ec.europa.eu).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Customer ID" },
        name: { type: "string", description: "Proposed name" },
        address_lines: CUSTOMER_ADDRESS_FIELD,
        country: COUNTRY_FIELD,
        uid: { type: ["string", "null"], description: "Proposed VAT ID; absent or null = none" },
      },
      required: ["id", "name", "address_lines", "country"],
    },
  },
] as const;

const CORE_TOOL_DEFINITIONS = [
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
        customer_revision: CUSTOMER_REVISION_FIELD,
        number: { type: "string", description: "Invoice number — required, comes with the request" },
        document_date: DOCUMENT_DATE_FIELD,
        service_period: SERVICE_PERIOD_SCHEMA,
        lines: { type: "array", items: LOCAL_LINE_SCHEMA, description: "Invoice lines (required)" },
        net_total: { type: "number", description: "Declared net total — must equal sum(qty*unit_price) over the lines" },
        currency: { type: "string", description: "Must be EUR" },
        payment_term_days: { type: "number", description: "Days until due, from issue (optional, defaults to the company's own setting)" },
        memo: { type: "string", description: "Free-form note (optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["customer_id", "number", "document_date", "service_period", "lines", "net_total", "currency"],
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
        customer_revision: CUSTOMER_REVISION_FIELD,
        number: { type: "string", description: "Invoice number as it would appear on the rendered PDF" },
        document_date: PREVIEW_DOCUMENT_DATE_FIELD,
        service_period: SERVICE_PERIOD_SCHEMA,
        lines: { type: "array", items: LOCAL_LINE_SCHEMA, description: "Invoice lines (required)" },
        net_total: { type: "number", description: "Declared net total — must equal sum(qty*unit_price) over the lines" },
        currency: { type: "string", description: "Must be EUR" },
        payment_term_days: { type: "number", description: "Days until due, from issue (optional)" },
        memo: { type: "string", description: "Free-form note (optional)" },
      },
      required: ["customer_id", "number", "document_date", "service_period", "lines", "net_total", "currency"],
    },
    outputSchema: PREVIEW_INVOICE_OUTPUT_SCHEMA,
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
        document_date: DOCUMENT_DATE_FIELD,
        credit_total: { type: "number", description: "Declared net credit total" },
        currency: { type: "string", description: "Must match the invoice's currency" },
        reason: { type: "string", description: "Why this credit note is being issued" },
        service_period: { ...SERVICE_PERIOD_SCHEMA, description: "Optional — defaults to the invoice's own service period" },
        lines: { type: "array", items: LOCAL_LINE_SCHEMA, description: "Explicit credit lines for a partial credit (optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["invoice_id", "number", "document_date", "credit_total", "currency", "reason"],
    },
  },
  {
    name: "get_invoice",
    description: "Get a single invoice with its lines and the customer data as issued (`customer`). Accepts the invoice ID or its number.",
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
    description: "Get a single credit note with its lines and the customer data as issued (`customer`)",
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
    outputSchema: DOCUMENT_OUTPUT_SCHEMA,
  },
] as const;

export const LOCAL_TOOL_DEFINITIONS: readonly LocalToolDefinition[] = [
  ...CUSTOMER_TOOL_DEFINITIONS,
  ...CORE_TOOL_DEFINITIONS,
  ...QUOTE_TOOL_DEFINITIONS,
  ...ITEM_TOOL_DEFINITIONS,
];
