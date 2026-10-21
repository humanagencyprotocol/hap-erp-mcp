/**
 * Local catalogue item tools (Part C, docs/local-production-contract.md §5).
 * Merged into LOCAL_TOOL_DEFINITIONS by definitions.ts; every name here needs
 * a handler in tools/items.ts. Vendor-neutral wording (docs/contract.md).
 */
import type { LocalToolDefinition } from "./definitions.js";

const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};

/** The optional catalogue link on a document line (used by definitions.ts' line schema). */
export const LINE_ITEM_ID_FIELD = {
  type: "string" as const,
  description:
    "Catalogue item this line is for (optional). The item must exist and be active. The line still states its own " +
    "description, unit_price and vat_rate — the item never fills them; the item's list price at this moment is " +
    "stored next to the line so a different line price stays visible.",
};

/** Optional pin of the item revision a line was prepared for (used by definitions.ts' line schema). */
export const LINE_ITEM_REVISION_FIELD = {
  type: "number" as const,
  description:
    "Revision of the item this line was prepared for (optional, needs item_id; see the item's `revision`). " +
    "If the item has changed since, the call is refused naming both revisions.",
};

const REVISION_FIELD = {
  type: "number" as const,
  description: "Revision of the item this change is for — refused if the item has changed since (see get_item).",
};

const NULLABLE_STRING = { type: ["string", "null"] };

/** What get_item / create_item / update_item / update_item_price return (structuredContent). */
export const ITEM_OUTPUT_SCHEMA = {
  type: "object",
  title: "Catalogue item",
  properties: {
    id: { type: "string", title: "Item ID" },
    sku: { ...NULLABLE_STRING, title: "Item number" },
    name: { type: "string", title: "Name" },
    description: { ...NULLABLE_STRING, title: "Description" },
    kind: { type: "string", enum: ["service", "product"], title: "Kind" },
    unit: { type: "string", title: "Unit" },
    list_price: { type: "number", title: "List price" },
    currency: { type: "string", title: "Currency" },
    vat_rate: { type: "number", title: "VAT rate (%)" },
    active: { type: "boolean", title: "Active" },
    revision: { type: "number", title: "Revision" },
    stock: { type: "null", title: "Stock (not tracked)" },
    created_at: { ...NULLABLE_STRING, title: "Created" },
    updated_at: { ...NULLABLE_STRING, title: "Updated" },
  },
  required: ["id", "name", "kind", "unit", "list_price", "currency", "vat_rate", "active", "revision"],
};

const KIND_FIELD = { type: "string" as const, enum: ["service", "product"], description: "service or product" };

export const ITEM_TOOL_DEFINITIONS: readonly LocalToolDefinition[] = [
  {
    name: "list_items",
    description: "List/search catalogue items (item number, name, unit, list price, VAT rate). Active items only unless active is false. Each item carries its `revision` — pass it as a line's item_revision to pin it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text search across item number (sku) and name" },
        active: { type: "boolean", description: "true (default): active items; false: inactive items" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_item",
    description:
      "Get a single catalogue item, including its list price, VAT rate and revision. Inactive items are returned too. " +
      "Pass revision to read an earlier revision's content.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Item ID" },
        revision: { type: "number", description: "Earlier revision to read (optional, default: current)" },
      },
      required: ["id"],
    },
    outputSchema: ITEM_OUTPUT_SCHEMA,
  },
  {
    name: "create_item",
    description:
      "Add a catalogue item (revision 1). The item number (sku), when given, must be unique. Currency is EUR.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Item name" },
        kind: KIND_FIELD,
        unit: { type: "string", description: "Unit label, e.g. \"Std.\" or \"Stk.\"" },
        list_price: { type: "number", description: "Net list price per unit in EUR (>= 0)" },
        vat_rate: { type: "number", description: "VAT rate in percent, e.g. 20 for 20%" },
        sku: { type: "string", description: "Item number (optional, unique)" },
        description: { type: "string", description: "Longer description (optional)" },
        ticket_id: TICKET_FIELD,
      },
      required: ["name", "kind", "unit", "list_price", "vat_rate"],
    },
    outputSchema: ITEM_OUTPUT_SCHEMA,
  },
  {
    name: "update_item",
    description:
      "Change an item's name, item number, unit, kind, description or active flag (next revision). Price and VAT " +
      "rate are refused here — they change only through update_item_price. An inactive item cannot go on new " +
      "document lines; documents already issued keep pointing at it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Item ID" },
        revision: REVISION_FIELD,
        name: { type: "string", description: "New name" },
        sku: { type: ["string", "null"], description: "New item number (null removes it)" },
        unit: { type: "string", description: "New unit label" },
        kind: KIND_FIELD,
        description: { type: ["string", "null"], description: "New description (null removes it)" },
        active: { type: "boolean", description: "false deactivates the item for new documents" },
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision"],
    },
    outputSchema: ITEM_OUTPUT_SCHEMA,
  },
  {
    name: "update_item_price",
    description:
      "Change an item's list price and VAT rate (next revision). Both are required; refused if both equal the " +
      "current values. Documents already issued keep the price they were issued with.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Item ID" },
        revision: REVISION_FIELD,
        list_price: { type: "number", description: "New net list price per unit in EUR (>= 0)" },
        vat_rate: { type: "number", description: "New VAT rate in percent" },
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "list_price", "vat_rate"],
    },
    outputSchema: ITEM_OUTPUT_SCHEMA,
  },
];
