/**
 * The simulation package — ONE file for the email, CRM and ERP simulators.
 *
 * This JSON Schema is the `package` argument of `load_simulation` in all three
 * connectors and must stay byte-identical across hap-erp-mcp, hap-crm-mcp and
 * hap-email-mcp (each connector uses its part; the rest is accepted and ignored).
 * hap-e2e compares the three published tool schemas, so a copy that drifts fails
 * there. Each connector's own parser stays the authority — this schema tells the
 * agent what to build; the parser refuses what it cannot load.
 */
export const SIMULATION_PACKAGE_SCHEMA = {
  type: "object",
  description:
    "Simulation package: one company's test world for the email, CRM and ERP simulators — each loads its part and " +
    "ignores the rest. A simulator can be loaded once; a second load is refused.",
  required: ["name", "currency", "customers", "products", "cases"],
  properties: {
    name: { type: "string", minLength: 1, description: "Company name (renamed), e.g. \"Bergmann Ersatzteile GmbH\"." },
    email: {
      type: "string",
      description: "Optional. The company's own mailbox the requests arrive in and replies are sent from, e.g. \"verkauf@bergmann-ersatzteile.example\".",
    },
    currency: { type: "string", pattern: "^[A-Z]{3}$", description: "ISO 4217 code for all prices, e.g. \"EUR\"." },
    customers: {
      type: "array",
      minItems: 1,
      description: "Customers as the cases need them (renamed). Used by CRM (as contacts) and ERP.",
      items: {
        type: "object",
        required: ["name", "credit_limit"],
        properties: {
          id: { type: "string", description: "Optional stable id, e.g. \"cust-1\" (default: cust-<n> by position). Same id in CRM and ERP." },
          name: { type: "string", minLength: 1, description: "Customer company name (renamed)." },
          email: { type: "string", description: "Optional. Customer's email address (renamed) — the sender of their requests." },
          country: { type: "string", description: "Optional. ISO country code, e.g. \"AT\"." },
          credit_limit: { type: "number", minimum: 0, description: "Credit limit in the package currency." },
          open_balance: { type: "number", minimum: 0, description: "Optional. Unpaid amount at the time of the cases (default 0)." },
          payment_terms: { type: "string", description: "Optional, e.g. \"NET30\"." },
        },
      },
    },
    products: {
      type: "array",
      minItems: 1,
      description: "Products/services as the cases need them (renamed). Used by ERP. Stock and price as at the time of the cases.",
      items: {
        type: "object",
        required: ["sku", "name", "list_price", "stock"],
        properties: {
          id: { type: "string", description: "Optional stable id, e.g. \"item-1\" (default: item-<n> by position)." },
          sku: { type: "string", minLength: 1, description: "Article number, unique within the package." },
          name: { type: "string", minLength: 1, description: "Product name (renamed if identifying)." },
          unit: { type: "string", description: "Optional, e.g. \"pcs\", \"set\" (default \"pcs\")." },
          list_price: { type: "number", minimum: 0, description: "Net list price per unit in the package currency." },
          stock: { type: "integer", minimum: 0, description: "Units in stock at the time of the cases (0 reproduces \"not in stock\")." },
        },
      },
    },
    contacts: {
      type: "array",
      description: "Optional. Extra CRM contacts beyond the customers (leads, partners, vendors). Used by CRM.",
      items: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 1 },
          email: { type: "string" },
          phone: { type: "string" },
          company: { type: "string" },
          role: { type: "string" },
          type: { type: "string", enum: ["customer", "lead", "partner", "vendor"] },
          stage: { type: "string", enum: ["new", "active", "inactive", "churned"] },
          tags: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
      },
    },
    cases: {
      type: "array",
      minItems: 1,
      description: "The real cases (renamed). Each request lands in the inbox; the reply is what the people actually sent — stored for comparison, never shown to the agent that works the inbox. Used by the email simulator.",
      items: {
        type: "object",
        required: ["id", "request", "reply"],
        properties: {
          id: { type: "string", minLength: 1, description: "Unique case id, e.g. \"c1\"." },
          request: {
            type: "object",
            required: ["from", "subject", "body"],
            properties: {
              from: {
                type: "object",
                required: ["name", "email"],
                properties: {
                  name: { type: "string", minLength: 1, description: "Sender's name (renamed)." },
                  email: { type: "string", description: "Sender's email (renamed) — normally a customer's email." },
                },
              },
              subject: { type: "string", minLength: 1 },
              body: { type: "string", minLength: 1, description: "The request text (a phone call becomes a short written note)." },
              received_at: { type: "string", description: "Optional ISO date-time the request arrived (default: load time)." },
            },
          },
          reply: {
            type: "object",
            required: ["subject", "body"],
            properties: {
              subject: { type: "string", minLength: 1 },
              body: { type: "string", minLength: 1, description: "The reply the people actually sent (or confirmed as correct)." },
            },
          },
          notes: { type: "string", description: "Optional. What was special about the case (not in stock, credit limit, discount …)." },
        },
      },
    },
  },
} as const;
