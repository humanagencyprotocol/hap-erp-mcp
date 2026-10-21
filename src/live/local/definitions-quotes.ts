/**
 * Local quote tools (Part B, docs/local-production-contract.md §4 with §12
 * D2/D3). Merged into LOCAL_TOOL_DEFINITIONS by definitions.ts; every name
 * here needs a handler in tools/quotes.ts (dispatch.ts checks).
 *
 * Names and semantics follow the simulator's quote tools (create_quote,
 * update_quote, get_quote, list_quotes) so an agent sees one interface. Local
 * differences: priced lines, the number and document_date come with the
 * request, the PDF is issued at create/update, and there is no send_quote or
 * convert_quote_to_order — the PDF goes out by email (get_document kind
 * "quote-pdf") and a quote becomes an invoice via create_invoice {quote_id,
 * quote_revision}. Vendor-neutral wording (docs/contract.md).
 *
 * Constants are local (not imported from definitions.ts): definitions.ts
 * imports this module at load, so importing back would be a cycle.
 */
import type { LocalToolDefinition } from "./definitions.js";
import { LINE_ITEM_ID_FIELD, LINE_ITEM_REVISION_FIELD } from "./definitions-items.js";

const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};

const QUOTE_LINE_SCHEMA = {
  type: "object" as const,
  properties: {
    item_id: LINE_ITEM_ID_FIELD,
    item_revision: LINE_ITEM_REVISION_FIELD,
    description: { type: "string", description: "Line description" },
    qty: { type: "number", description: "Quantity (positive)" },
    unit: { type: "string", description: "Unit label (optional, default \"Stk.\")" },
    unit_price: { type: "number", description: "Agreed net unit price in EUR" },
    vat_rate: { type: "number", description: "VAT rate in percent, e.g. 20 for 20%" },
  },
  required: ["description", "qty", "unit_price", "vat_rate"],
};

const NUMBER_FIELD = {
  type: "string" as const,
  description:
    "Quote number — required, comes with the request, in the quote series your instructions set (separate from " +
    "invoice and credit-note numbers). Refused if already used by any quote, invoice or credit note, or if " +
    "malformed (1–64 letters, digits, \".\", \"_\" or \"-\", starting and ending with a letter or digit).",
};

const DOCUMENT_DATE_FIELD = {
  type: "string" as const,
  description:
    "The quote's date (ISO \"YYYY-MM-DD\"), printed on it. Required. Refused unless it is today in the company's " +
    "own calendar (company file timezone, default Europe/Vienna).",
};

const VALUE_FIELD = {
  type: "number" as const,
  description: "Declared net total — must equal sum(qty × unit_price) over the lines, in cents",
};
const DISCOUNT_FIELD = {
  type: "number" as const,
  description: "Document discount in percent — must be 0 (each line carries its agreed price)",
};
const CURRENCY_FIELD = { type: "string" as const, description: "Must be EUR" };
const VALID_UNTIL_FIELD = {
  type: "string" as const,
  description: "ISO date the offer is valid until (optional; not before document_date). Printed on the quote.",
};
const NOTES_FIELD = { type: "string" as const, description: "Internal note (optional, not printed)" };

const QUOTE_PDF_OUTPUT_SCHEMA = {
  type: "object",
  title: "Quote preview",
  properties: {
    filename: { type: "string", title: "Filename" },
    contentType: { type: "string", title: "Content type" },
    contentBase64: { type: "string", title: "Content (base64)" },
    sha256: { type: "string", title: "SHA-256 fingerprint", description: "Of the raw PDF bytes — equals the archived fingerprint when issued with the same arguments on the same day." },
    pages: { type: "number", title: "Pages" },
  },
  required: ["filename", "contentType", "contentBase64", "sha256", "pages"],
};

export const QUOTE_TOOL_DEFINITIONS: readonly LocalToolDefinition[] = [
  {
    name: "list_quotes",
    description: "List quotes, optionally filtered by status (issued / converted) or customer. Each result includes its current revision.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["issued", "converted"], description: "Filter by status" },
        customer_id: { type: "string", description: "Filter by customer ID" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_quote",
    description:
      "Get a single quote (ID or number) with its lines, the customer data as quoted (`customer`), its current " +
      "revision and the issued PDF's fingerprint (`document`). Pass `revision` to read an earlier revision's content.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID or number" },
        revision: { type: "number", description: "Earlier revision to read (optional, default: current)" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_quote",
    description:
      "Issue a quote: renders the quote PDF and archives it (revision 1, status `issued`). `number` comes with the " +
      "request — this connector never assigns one. The connector recomputes the net total from the lines and refuses " +
      "the call if the declared value, discount_pct (must be 0) or currency does not match, and refuses line VAT that " +
      "contradicts the customer's tax treatment. There is no separate send step: to send the quote, attach its PDF " +
      "(get_document kind \"quote-pdf\") to an email. To invoice it, call create_invoice with quote_id and quote_revision.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        number: NUMBER_FIELD,
        document_date: DOCUMENT_DATE_FIELD,
        lines: { type: "array", items: QUOTE_LINE_SCHEMA, description: "Quote lines (required)" },
        value: VALUE_FIELD,
        discount_pct: DISCOUNT_FIELD,
        currency: CURRENCY_FIELD,
        valid_until: VALID_UNTIL_FIELD,
        notes: NOTES_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["customer_id", "number", "document_date", "lines", "value", "discount_pct", "currency"],
    },
  },
  {
    name: "update_quote",
    description:
      "Revise an issued quote: produces the next revision with its own archived PDF (same number). Omitted lines, " +
      "valid_until and notes are kept. Takes the customer's current data. Refused for a quote already invoiced. " +
      "`revision` is required and must be the quote's current revision.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Quote ID or number" },
        revision: { type: "number", description: "The quote's current revision (required; refused if the quote has moved on)" },
        document_date: DOCUMENT_DATE_FIELD,
        lines: { type: "array", items: QUOTE_LINE_SCHEMA, description: "Replacement lines (optional — omit to keep)" },
        value: VALUE_FIELD,
        discount_pct: DISCOUNT_FIELD,
        currency: CURRENCY_FIELD,
        valid_until: VALID_UNTIL_FIELD,
        notes: NOTES_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "document_date", "value", "discount_pct", "currency"],
    },
  },
  {
    name: "preview_quote",
    description:
      "Render the quote PDF exactly as create_quote (without id) or update_quote (with id) would, WITHOUT issuing it — " +
      "no number is used, nothing is archived or recorded. Same arguments; any document_date is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing quote (ID or number) — preview its next revision (optional)" },
        revision: { type: "number", description: "With id: the quote's current revision (optional)" },
        customer_id: { type: "string", description: "Customer ID (new quote)" },
        number: { type: "string", description: "Quote number as it would appear (new quote)" },
        document_date: { type: "string", description: "The quote's date (ISO \"YYYY-MM-DD\") as it would be printed — any date" },
        lines: { type: "array", items: QUOTE_LINE_SCHEMA, description: "Quote lines" },
        value: VALUE_FIELD,
        discount_pct: DISCOUNT_FIELD,
        currency: CURRENCY_FIELD,
        valid_until: VALID_UNTIL_FIELD,
        notes: NOTES_FIELD,
      },
      required: ["document_date", "value", "discount_pct", "currency"],
    },
    outputSchema: QUOTE_PDF_OUTPUT_SCHEMA,
  },
];
