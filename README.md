# HAP ERP MCP Server

A generic ERP for AI agents, built as an [MCP](https://modelcontextprotocol.io) server and gated through the [Human Agency Protocol](https://humanagencyprotocol.org).

> **@humanagencyp/erp-mcp** — unpublished (version 0.1.0, not yet on npm)

---

## What It Does

The quote-to-order flow — the common subset of Microsoft Dynamics 365 Business Central
(`salesQuotes` / `salesOrders` / `items` / `customers`), SAP Business One (`Quotations` /
`Orders` / `Items` / `BusinessPartners`), and Odoo (`sale.order` / `product.product` /
`res.partner`).

- **Items** — catalog: sku, name, unit, list price, stock
- **Customers** — name, currency, credit limit, open balance, payment terms
- **Quotes** — draft → sent → converted, with lines priced off the item catalog
- **Orders** — created by converting a sent quote; reserves stock

Every write is gated through the HAP `sales` profile (`hap-profiles/sales/0.1.profile.json`).

### Out of scope for 0.1

No invoices, delivery notes, payments, credit memos, or master-data changes
(no creating/editing items or customers). This connector only drives the
quote-to-order flow; billing and fulfillment stay in the source ERP.

---

## Quick Start

### Standalone

```bash
npm install
npm run build
node dist/index.js
```

Starts the MCP server with a SQLite database at `~/.hap/erp.db`. A new database
is empty — load test data with `load_simulation`, or seed it from a company file
(`ERP_COMPANY_FILE`, see below).

For Postgres:

```bash
DATABASE_URL=postgres://user:pass@host:5432/mydb node dist/index.js
```

---

## Tools

### Reads

| Tool | Description |
|------|-------------|
| `list_items` | Search items by sku/name |
| `get_item` | Get an item, including stock and list price |
| `find_customers` | Search customers by name/email |
| `get_customer` | Get a customer, including credit limit, open balance, available credit |
| `list_quotes` | List quotes, filter by status/customer |
| `get_quote` | Get a quote with its lines |
| `list_orders` | List orders, filter by customer |
| `get_order` | Get an order with its lines |

### Changes

| Tool | Description |
|------|-------------|
| `create_quote` | Create a draft quote (customer, lines, discount, value, currency) |
| `update_quote` | Update a draft quote (lines, discount, value, currency) — draft only |
| `send_quote` | Mark a draft quote sent (simulated — no email is actually sent) — draft → sent |
| `convert_quote_to_order` | Convert a sent quote into a confirmed order, reserving stock — sent → order |

Every change tool **requires** `value`, `discount_pct`, and `currency` in its call arguments.

### Test setup (simulation mode only)

| Tool | Description |
|------|-------------|
| `load_simulation` | Load a simulation package into the empty ERP — create only |
| `clear_simulation` | Delete all test data so a new package can be loaded |

These two are not part of the work the agent is tested on; see [Simulation mode](#simulation-mode).

---

## Why the connector re-derives the total (this is the point)

The gateway's bounds engine enforces limits on the **declared** `value`,
`discount_pct`, and `currency` fields of a tool call — it has no visibility
into line items. That makes the declaration the security boundary: if this
connector executed whatever document the lines actually describe while the
gateway bound-checked a different, merely-asserted number, the bound would be
decorative.

So every change tool:

1. **Recomputes** the net total as `sum(qty × list_price) × (1 − discount_pct / 100)`,
   rounded to cents, and refuses the call if the declared `value` differs by
   more than 0.01.
2. Refuses if the declared `discount_pct` is outside `[0, 100]`, or — on
   `send_quote` / `convert_quote_to_order` — differs from the discount already
   recorded on the document (the discount is fixed once a quote is sent).
3. Refuses if the declared `currency` differs from the customer's currency
   (on `create_quote`) or the document's stored currency (on
   `update_quote` / `send_quote` / `convert_quote_to_order`).
4. On `convert_quote_to_order`: refuses if `open_balance + net_total` would
   exceed the customer's `credit_limit`, and refuses if any line lacks
   sufficient stock. Only after every line clears the stock check does it
   reserve (decrement) stock — a shortfall on any line rejects the whole
   conversion instead of partially reserving.
5. Enforces the document state machine: `update_quote` and `send_quote` only
   act on `draft` quotes; `convert_quote_to_order` only acts on `sent` quotes
   (which also blocks double-conversion — a converted quote is no longer
   `sent`).
6. Refuses unknown `customer_id`/`item_id`, and non-positive or non-integer
   `qty`.

Every refusal is returned as `isError: true` with a message naming the field,
the declared value, and the computed/expected value.

---

## Database

**SQLite (default)** — zero config. Data stored at `~/.hap/erp.db` (or
`${HAP_DATA_DIR}/erp.db` when the gateway sets `HAP_DATA_DIR`). Auto-backup to
`erp.backup.db` daily.

**Postgres** — set `DATABASE_URL` to a connection string. For teams where
multiple gateways need shared access.

Schema is created automatically on first start. An empty database is seeded
from the company file (`ERP_COMPANY_FILE`, see below); without one it stays
empty. There is no built-in demo data.

---

## Simulation mode

The connector has a switch, `ERP_MODE`:

| Mode | What answers | Status |
|---|---|---|
| `simulation` (default) | the built-in simulated ERP (the database above) | available |
| `live` | the company's real ERP | no adapter in 0.x — **every call is refused** with a clear message, nothing is read or changed |

The point: a three-week test runs on exactly this connector, its tools and its
HAP profile. Only the system behind it is simulated, so the tickets issued during
the test are the same tickets that will be issued live. Going live = switch the
mode and connect the real system; mandates and agent setup stay as they are.

**Company file.** `ERP_COMPANY_FILE=/path/to/company.json` seeds an empty
database with the company's items, prices, stock and customers (invented but
realistic test data) **at connector start** — still the way to go for local
development. The file is validated strictly and refused whole on the first
problem. Example: [`examples/company.example.json`](examples/company.example.json).

**`load_simulation` (MCP tool).** The gateway-facing way to load test data: a
simulation package — `{ name, currency, customers: [...], products: [...] }`
(`items` accepted as a legacy alias for `products`) — passed as the `package`
argument, in the same flat format the CRM connector and the email simulator
use (they each read only the parts they need; `contacts` and `cases` are
accepted and ignored here). Simulation mode only; refused in live mode like
every other tool. **Create only, never edit** — refused once test data was
already loaded, or any customer, product, change, quote, or order exists. Records the
package's name and the SHA-256 of its canonical (key-order-independent) JSON
in `simulation_load`. Example package:
[`examples/package.example.json`](examples/package.example.json).

**`clear_simulation` (MCP tool).** Deletes all test data — customers, products,
quotes, orders, and the record of changes, refusals and request hand-overs — so
the same cases can run again under a different setup, or other cases under the
same one: clear, then load. Simulation mode only; refused in live mode. The clear
itself stays recorded as one change with its `ticket_id`; that entry does not
block the next load. Cannot be undone — take an `export` first if you want to
keep the record.

**Changes.** Every change the connector performs is recorded as its own entry —
time, tool, document, status, amount, and the `ticket_id` the gateway injected.
A document only keeps its latest `ticket_id` (sending a quote replaces the one
from creating it), so this record, not the document, lines up ticket and effect
one to one.

**Refusals after the gateway.** When the connector refuses a change call the
gateway already let through (false declared value, credit limit, stock, wrong
state), it records the refusal with the `ticket_id` the gateway injected. A
ticket then exists for an action that never happened, and this record is the
only place that says so.

**Local commands** (not MCP tools — the agent can neither read nor change them).
Point them at the same database the gateway uses — for a gateway install that is
`HAP_DATA_DIR=~/.suveren`:

```bash
HAP_DATA_DIR=~/.suveren erp-mcp scenario next examples/scenario.example.json   # hand over the next request, record the time
HAP_DATA_DIR=~/.suveren erp-mcp scenario status examples/scenario.example.json
HAP_DATA_DIR=~/.suveren erp-mcp export > record.json                          # triggers, changes, refusals, quotes + lines, orders, simulation_load, mode
```

The export lines up **trigger → ticket → effect**: each request's hand-over time,
each change with the `ticket_id` of the ticket that authorised it, and each
refusal with the `ticket_id` of the ticket whose action did not happen.

---

## HAP Profile

This server is gated through the `sales` profile
(`github.com/humanagencyprotocol/hap-profiles/sales@0.1`):

- **Action types** — `quote`, `send`, `order`
- **Bounds** — `read_access`, `value_max`, `discount_max`, `order_value_daily_max`,
  `quote_daily_max`, `send_daily_max`, `order_daily_max`
- **Execution fields** — `value`, `discount_pct`, `currency` (all `source: "declared"`,
  verified by this connector against the lines before the gateway ever sees them)

---

## License

MIT

See [humanagencyprotocol.org](https://humanagencyprotocol.org) for the full protocol specification.
