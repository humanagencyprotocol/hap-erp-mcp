# ERP Local in production — build contract (E1 customers, E2 quotes, E3 catalogue)

Status: **contract, not code** (2026-10-21). Parallel worktrees build from this file; a change to it
goes through the contract owner (Part 0 below), never silently in a part's branch.

Decisions this contract rests on (Andreas, 2026-10-21):

- Customer master data belongs to the **invoicing** area. Catalogue items too (same reasoning:
  an item's price and VAT rate end up on invoices).
- E1 includes an **online EU VIES** VAT-ID check.
- Versions (next minor): `@humanagencyp/erp-mcp` 0.9.5 → **0.10.0**, hap-profiles `invoicing`
  0.1 → **0.2**, gateway 0.37.0 → **0.38.0**. `sales` stays at **0.4** — Local quotes fit its
  `quote` / `send` action types and `value` / `discount_pct` / `currency` bounds unchanged.
- **Never hardcode profile or vendor names in gateway code.** Everything the gateway does for
  these tools comes from manifest and profile declarations. Part D adds generic mechanisms only.

Scope: the **Local** live adapter (`ERP_MODE=live`, `ERP_LIVE_ADAPTER=local`). The simulation
keeps its own surface; where a Local tool has a simulator twin it keeps the twin's **name and
semantics** (one interface in both modes), and this file says exactly where the inputs differ.

Vocabulary as in the UI spec: mandate, ticket, connector, approve/reject, blocked/refused/failed.

---

## 1. Binding requirements

Every part must satisfy these. Each names the test that proves it; a part is not done until its
tests exist and pass. (R1–R7 come from the session that built ERP Local, 2026-10-21.)

| # | Requirement | Owner | Proving test |
|---|---|---|---|
| R1 | **Snapshot first.** Invoices, credit notes and quotes store the customer's name, address lines, country and VAT ID **as issued**, and render only from that snapshot. Today `local_invoices` stores only `customer_id` + `tax_mode`, and `invoiceVars` / `create_credit_note` read the **current** customer row (`src/live/local/tools/invoices.ts` `invoiceVars`, and the `buildViewModel` call in `create_credit_note`). Once customers can change, a credit note on an old invoice would print today's address. Ships **before or with** E1. Existing rows are snapshotted from current data at migration time and marked `customer_snapshot_source = 'migrated'`. | A | `test/live-local-snapshot.test.ts`: issue invoice → `update_customer_tax_data` (new address + VAT ID) → `create_credit_note` on the old invoice prints the **old** address/VAT ID; `get_invoice` returns the snapshot; a pre-migration DB fixture gets `customer_snapshot_source='migrated'` on every old row and identical values. |
| R2 | **Customer writes are tax-relevant → review only.** `invoicing@0.2` declares `"commitment_modes": ["review"]`; the Authority Server refuses an automatic mandate under it (hap-core `isCommitmentModeAllowed`) and the gateway's mandate screen offers review only (`apps/ui/src/lib/commit-mode.ts`). This makes the **whole** invoicing area review-only — see Open decisions O1. An `invoicing@0.1` mandate (which may be automatic) cannot authorize a customer/item write: those action types are not in 0.1's registry, so the request fails `INVALID_ACTION_TYPE`. | Profiles + D | hap-e2e: create an automatic mandate under `invoicing@0.2` → refused by the AS; a `create_customer` call under an `invoicing@0.1` mandate → refused, connector never called. |
| R3 | **VIES result is FROM THE SYSTEM.** The VAT-ID check is a gateway-run preview read of the connector (`check_vat_id`), rendered on the card as a check / system value — never an argument the AI supplies, never AI text. | A + D | Gateway unit test on the manifest-declared check (Part D); A: `create_customer` has no input field that carries a VIES result. |
| R4 | **UID/country change on a customer with issued invoices gets its own check line.** `check_vat_id` / `preview_customer_change` returns `issued_documents` (count of invoices + credit notes already issued to that customer); the manifest declares a check that reads it. | A + D | A: `preview_customer_change` returns the count; D: card shows "Already invoiced: N documents keep the old data" line. |
| R5 | **VIES is an outside call — declared.** The Local mode note stops promising "no shared access" without qualification; the manifest declares the outside call (`network` declaration, Part D) and the connector names it in its tool description. Offline/unreachable is a **visible** "not checked" state, never "valid". | A + D | A: VIES stub unreachable → `vies.status = "not_checked"` with reason; D: card shows the not-checked line and the outage sentence (§3.5). |
| R6 | **Deterministic PDFs.** Quote PDFs render through the same `pdfmake` path as invoices (`renderInvoiceDocument`, fixed creation date = `document_date` at UTC midnight); `preview_quote` sha256 == the archived sha256 of the quote `send_quote` freezes, for the same revision (AU4). | B | `test/live-local-quote-pdf.test.ts`: preview sha == archived sha; two renders byte-identical. |
| R7 | **Numbering.** Invoices + credit notes keep their one shared, request-supplied namespace (`local_numbers`, unchanged). Quotes use a **separate** series (`local_quote_numbers`) and a separate archive directory. Converting a quote to an invoice still requires the invoice `number` in the request and `document_date` == today. | B | Quote number never collides with or consumes an invoice number; conversion without `number` refused; with yesterday's date refused. |
| R8 | **VAT vs tax mode on conversion.** `refuseIfVatContradictsTaxMode` applies to quote → invoice conversion exactly as to a hand-written invoice (the quote's lines may carry 20 % while the customer's **current** tax data makes it reverse charge). | B | Quote with 20 % lines for a customer later changed to an EU VAT ID → conversion refused, nothing issued. |
| R9 | **Customer writes live in exactly one area.** Write tools carry `"profile": "invoicing"` in the manifest; `readAlsoUnder` is for reads only and never appears on a write override. The simulator's customer reads under `sales` stay as they are. | D | Manifest lint test: no override with `category !== "read"` declares `readAlsoUnder`. |
| R10 | **CRM → ERP convert is idempotent.** One customer per `crm_contact_id` and one per VAT ID: a second `create_customer` for the same CRM contact or the same VAT ID is refused naming the existing customer id (no duplicate). | A | Two `create_customer` calls, same `crm_contact_id` → second refused with the first's id; same for VAT ID. |
| R11 | **Revision rule** (`docs/contract.md`) for customers and items: every change produces the next revision, update tools name the revision they change, old revisions are kept. | A, C | Stale `revision` → refused naming both revisions, nothing changed; `get_customer {id, revision}` returns old content. |
| R12 | **Backward compatible DB.** Every migration is additive, idempotent and runs on Andreas's existing Local DB (demo data) without changing any existing value except adding snapshots (R1). Archived PDFs are never touched. | A, B, C | Migration test on a fixture copied from a 0.9.5 DB: all old invoices still `get_document`-verify; second start is a no-op. |

---

## 2. Rules every new tool follows

These extend `docs/contract.md`; nothing there changes.

1. **Declared values are recomputed.** Every write recomputes what it declares (`value`, `net_total`,
   `list_price`, `discount_pct`, `currency`) and refuses on mismatch with the existing `refuse()`
   shape (`src/money.ts`). The declaration is all a governing layer can see.
2. **Revision rule** for customers, items and quotes (R11). `create_*` → revision 1; each successful
   change → next revision; a change tool takes `revision` and is refused on mismatch with
   `<Document> <id> is at revision <N>; this request is for revision <M>.` (customers: `Customer`,
   items: `Item`). Old revisions stay readable via `get_* {id, revision}`.
3. **`ticket_id`** on every write (`TICKET_FIELD`, set by the gateway, never by the AI), stored on the
   row and on the revision snapshot.
4. **Nothing on refusal.** A refused call writes nothing, consumes no number, calls no outside
   service after the refusal point, and says `Nothing was saved.` / `Nothing was issued.`
5. **Order of side effects** stays render → write-once archive → one DB transaction (as
   `create_invoice` today). An outside call (VIES) happens **before** the transaction and its
   result is stored inside it.
6. **No AI text where it would look like system data.** No input field carries a check result,
   a "verified" flag or a VIES answer. Free text the AI writes (`notes`, `memo`, `description`)
   stays plain fields the card shows as from the AI.
7. **Tool descriptions are vendor-neutral** (as `docs/contract.md`): they name no gateway, profile
   or product. They do say when a tool makes an outside call (R5).
8. **Simulator parity.** A Local tool with a simulator twin keeps the twin's name, status machine,
   revision behaviour and refusal wording; differing inputs are listed per tool. A simulator-only
   tool called in Local mode is refused naming the Local alternative (dispatch's existing pattern).

---

## 3. Part A — E1 customers (Local)

### 3.1 Customer record (output of every customer tool)

`uid` keeps its existing name (stored, CLI, import, `get_customer`); the card labels it "VAT ID".

```jsonc
{
  "id": "uuid",                       // assigned by the connector
  "name": "string",
  "address_lines": ["string"],        // street, zip + city, … (printed under the name)
  "country": "AT",                    // ISO 3166-1 alpha-2, upper case
  "uid": "ATU12345678" | null,        // VAT ID, normalised: upper case, no spaces/dots/dashes
  "email": "string" | null,
  "crm_contact_id": "string" | null,  // link to the CRM contact this customer was made from
  "revision": 1,
  "vies": {                           // last stored check, null when never checked
    "status": "valid" | "invalid" | "not_checked" | "not_applicable",
    "reason": "string" | null,        // e.g. "VIES unreachable (timeout after 8 s)"
    "checked_at": "ISO datetime" | null,
    "request_id": "string" | null,    // VIES consultation number (qualified check)
    "name": "string" | null,          // as VIES returned it — display only, never copied into the record
    "address": "string" | null
  } | null,
  "created_at": "ISO datetime",
  "updated_at": "ISO datetime"
}
```

### 3.2 Tools

| Tool | Kind | Governs (profile · action type) | Input | Output |
|---|---|---|---|---|
| `find_customers` | read (exists) | invoicing · read (`read_access`); also sales in simulation | `query?`, `limit?` + **new** `uid?`, `crm_contact_id?` (exact match) | `Customer[]` |
| `get_customer` | read (exists) | as above | `id`, **new** `revision?` | `Customer` (old revision: content from the snapshot) |
| `create_customer` | write | invoicing · `customer` | `name`, `address_lines`, `country`, `uid?`, `email?`, `crm_contact_id?`, `ticket_id` | `Customer` (revision 1) |
| `update_customer` | write | invoicing · `customer` | `id`, `revision`, `email?`, `crm_contact_id?` (at least one), `ticket_id` | `Customer` (next revision) |
| `update_customer_tax_data` | write | invoicing · `customer_tax` | `id`, `revision`, `name`, `address_lines`, `country`, `uid` (string or `null` = remove) — **all four required**, full replacement, `ticket_id` | `Customer` (next revision) |
| `check_vat_id` | internal read (card preview only) | invoicing · internal | `country`, `uid` | §3.4 |
| `preview_customer_change` | internal read (card preview only) | invoicing · internal | `id`, `name`, `address_lines`, `country`, `uid` | §3.4 |

Why two update tools instead of one with a per-field rule: the gateway maps **one tool to one
action type** (`staticExecution.action_type`); a field-dependent action type would need a new
gateway mechanism and a new way to bind it. Two tools give the tax-data change its own decision,
its own daily limit and its own card with nothing new in the gateway. `update_customer` refuses
any of `name`, `address_lines`, `country`, `uid` with:
`Refused: name/address/country/VAT ID are tax data — use update_customer_tax_data. Nothing was saved.`

Why `name` counts as tax data: the recipient's name and address are mandatory invoice contents
(§ 11 Abs. 1 Z 1 UStG / § 14 Abs. 4 Nr. 1 UStG) and are what the snapshot (R1) freezes. See O2.

### 3.3 Refusals (`create_customer`, `update_customer_tax_data`; in this order)

1. Shape: `name` non-empty; `address_lines` non-empty array of non-empty strings; `country` two
   letters (stored upper case) — same rules as the CLI's `validateNewCustomer`, which both share.
2. `uid` format (offline, deterministic): normalised, then must start with the VIES prefix of
   `country` (`GR` → `EL`, `XI` for Northern Ireland, else the country code) and match that
   country's pattern (table in `src/live/local/vat-id.ts`, one regex per EU state + `XI`).
   A `uid` for a non-EU country is stored as given (format not checked, VIES `not_applicable`).
3. Duplicates (R10): another customer with the same `uid`, or (create / `update_customer`) the
   same `crm_contact_id` → `Refused: customer <id> already has VAT ID <uid>. Nothing was saved.`
   (same for `crm_contact_id`). The AI is expected to `find_customers {uid | crm_contact_id}` first.
4. Revision (update tools only, R11).
5. `update_customer_tax_data` with content identical to the current revision → refused
   (`nothing would change`) — a revision must mean a change.
6. VIES (only when `uid` is set and the country is an EU state / `XI`): run at **execution**,
   before the transaction. `invalid` → `Refused: VIES reports VAT ID <uid> as not valid (checked
   <time>). Nothing was saved.` `not_checked` → **saved**, with `vies.status = "not_checked"` and
   the reason (see §3.5 for why this is not fail-closed). `valid` → saved with the result.

The card showed the preview-time VIES result; the stored result is the execution-time one. If
they differ, the stored one is the truth and is what `get_customer` returns; an `invalid` at
execution always refuses even when the card showed `valid` or `not checked`.

### 3.4 Preview reads (internal: the gateway runs them for the card; never listed to the AI)

`check_vat_id {country, uid}` →

```jsonc
{
  "uid": "ATU12345678",                 // normalised
  "format": "ok" | "wrong_prefix" | "wrong_pattern" | "not_applicable",
  "vies": { "status": "valid" | "invalid" | "not_checked" | "not_applicable",
            "reason": "string" | null, "checked_at": "ISO" | null, "request_id": "string" | null,
            "name": "string" | null, "address": "string" | null },
  "duplicate": false,                   // R10, so the card can show it before execution refuses
  "duplicate_of": "customer id" | null
}
```

`preview_customer_change {id, name, address_lines, country, uid}` →

```jsonc
{
  "current": { "name": "…", "address_lines": ["…"], "country": "AT", "uid": "…", "revision": 3 },
  "revision": 3,                                       // = current.revision, for the preview `version` check
  "changed": ["uid", "country"],                       // fields that differ from current
  "uid_or_country_changed": true,                      // R4 check reads this
  "tax_mode": { "now": "normal", "after": "reverse_charge" },   // deriveTaxMode on both
  "issued_documents": { "invoices": 4, "credit_notes": 1, "last_number": "2026-014" },  // R4
  "open_quotes": 1,                                    // draft/sent quotes that will refuse send (§4.4)
  "vat_check": { /* same object as check_vat_id */ }
}
```

`issued_documents` is what R4's check line reads: a VAT ID / country change on a customer with
issued documents is shown as its own line ("4 invoices, 1 credit note already issued — they keep
the old data"). Issued documents are never changed (R1); the line tells the person what the
change does **not** touch.

### 3.5 VIES — behaviour and the outage decision

- Endpoint: EU VIES REST, `POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number`
  with `{countryCode, vatNumber, requesterMemberStateCode, requesterNumber}`; the requester is the
  company file's own `uid` (qualified check → consultation number `requestIdentifier`, stored as
  `request_id`). If VIES refuses the requester (`INVALID_REQUESTER_INFO`), retry once without it
  (`request_id` stays null, `reason` says so).
- Config (connector env, set by the gateway from the manifest): `ERP_VIES_URL` (default the URL
  above; tests point it at a local stub), `ERP_VIES_TIMEOUT_MS` (default 8000),
  `ERP_VIES=off` (no call; every check is `not_checked`, reason `"VIES check switched off"`).
  `check_vat_id` uses at most 4000 ms, below the gateway's 5 s preview-read timeout
  (`preview.ts` `readPreview`), so a slow VIES shows as "not checked: timeout" rather than an
  unavailable preview.
- Mapping: `valid:true` → `valid`. `valid:false` with no service error → `invalid`. Network error,
  timeout, HTTP ≥ 500, or `userError` in `MS_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `TIMEOUT`,
  `MS_MAX_CONCURRENT_REQ`, `GLOBAL_MAX_CONCURRENT_REQ` → `not_checked` with the reason.
  `INVALID_INPUT` → the format check was wrong: `invalid` + a logged connector error.
- No caching: each call is one query; the stored result carries its time.
- **Data sent outside the computer:** only the customer's country + VAT ID and the company's own
  VAT ID — to the European Commission's VIES service. Nothing else. This is what R5 declares.

**Decision: fail-closed on `invalid`, the person decides on `not checked`.** Reasons:

1. `invalid` is an answer; saving a VAT ID the tax authority's own register rejects has no
   legitimate case (a brand-new VAT ID not yet in VIES is the exception, and the right action
   there is to wait — the customer can be saved without `uid` meanwhile).
2. `not checked` is the absence of an answer, and VIES outages are routine (single member-state
   back-ends are down for hours). Refusing would block all customer work during an outage and
   push people to work around the system — the worse outcome for control.
3. The person sees it: the card shows a **not checked** line with the reason, and the sentence
   "Saving is not blocked while VIES is unreachable — the customer is saved as not checked." The
   stored status stays `not_checked` and is shown on every later invoice card for that customer
   (§7.3, create_invoice check), so it cannot fade from view.
4. Issuing is **not** blocked for a `not_checked` customer either (same reasoning); the
   create_invoice card says so in its check line when the derived tax mode is reverse charge
   ("VAT ID not confirmed by VIES — reverse charge without confirmation"). Whether reverse-charge
   invoices should refuse without a `valid` result is open decision O3.

### 3.6 Snapshot (R1) — what A changes in the invoice path

- New columns on `local_invoices`, `local_credit_notes` (and B's `local_quote_revisions`):
  `customer_name`, `customer_address_lines` (JSON), `customer_country`, `customer_uid`,
  `customer_revision`, `customer_snapshot_source` (`'issued'` | `'migrated'`).
- `create_invoice` / `create_credit_note` write the snapshot from the customer row **read inside
  the same call** that derived the tax mode; rendering (`invoiceVars`, the credit-note
  `buildViewModel` call) reads the snapshot object, never `requireLocalCustomer` again.
- A credit note renders the **invoice's** snapshot (it corrects that document), not the customer's
  current data, and copies it into its own row.
- `get_invoice` / `get_credit_note` return the snapshot as `customer: {name, address_lines,
  country, uid, revision, source}`.
- `create_invoice` / `preview_invoice` gain optional `customer_revision`: if given and the
  customer is at another revision → refused naming both (R11 shape). The manifest uses it as the
  preview `version` so a tax-data change between approval and execution refuses instead of
  issuing to data nobody approved (§7.3).

---

## 4. Part B — E2 quotes (Local)

### 4.1 Status machine and numbering

Same as the simulator (`docs/contract.md`): `draft --send_quote--> sent --create_invoice{quote_id}-->
converted`; `cancelled` is not reachable in 0.10.0 (no cancel tool yet, as in the simulator).

- Number: assigned by the connector at `create_quote`, own series `local_quote_numbers`,
  format `Q-<YYYY>-<NNNN>` (year of creation, gapless per year, reserved in the insert transaction).
  Never shares a namespace or archive directory with invoices (R7). Format: O5.
- A sent quote's PDF is archived write-once at `<data>/erp-local-archive/quotes/<YYYY>/<number>-r<revision>.pdf`.

### 4.2 Tools

| Tool | Kind | Governs | Input (Local) | Differs from simulator |
|---|---|---|---|---|
| `list_quotes` | read | sales · read; also invoicing (`readAlsoUnder`) | `status?`, `customer_id?`, `limit?` | — |
| `get_quote` | read | as above | `id` (id or number), `revision?` | output has `customer` snapshot, `document` (sha256, filename) when sent, line fields as below |
| `create_quote` | write | sales · `quote` | `customer_id`, `lines[]`, `discount_pct`, `value`, `currency`, `valid_until?`, `notes?`, `ticket_id` | lines are priced lines (below), not `{item_id, qty}` |
| `update_quote` | write | sales · `quote` | `id`, `revision?`, `lines?`, `discount_pct`, `value`, `currency`, `valid_until?`, `notes?`, `ticket_id` | `revision` accepted (enforced when given) |
| `send_quote` | write | sales · `send` | `id`, `revision`, `value`, `discount_pct`, `currency`, `document_date`, `ticket_id` | adds `document_date` (must be today, company timezone); freezes + archives the PDF |
| `preview_quote` | internal read | sales · internal | `id`, `revision`, `document_date` (any date) | new (Local only) |
| `get_document` | internal read | invoicing · internal (exists) | `kind: "quote-pdf"`, `id` | new kind; sent quotes only |
| `convert_quote_to_order` | — | — | — | Local refuses: `no orders in local mode — issue the invoice with create_invoice {quote_id, quote_revision}` |

Local quote line (same shape as an invoice line, plus the catalogue link from Part C):
`{item_id?, description, qty, unit?, unit_price, vat_rate}`; stored with `line_net` and, when
`item_id` is set, `list_price` (the item's price at that revision — for the card's deviation check).

- `value` = Σ round(qty × unit_price) in cents, × (1 − discount_pct/100).
- **`discount_pct` must be 0 in Local** (refused otherwise: `Local quotes price each line — put
  the agreed price in unit_price.`). It stays a required declared field so the `sales` bounds
  (`discount_max` requiredFor `quote`) keep working unchanged. Invoices have no document discount,
  so a discounted quote could not convert 1:1. See O4.
- `currency` must be `EUR`; the customer must exist (Local customers, Part A).
- Each revision snapshots the customer (R1) incl. `customer_revision`. `send_quote` refuses when
  the customer has moved to a later revision since the quote revision was made
  (`Customer <id> changed since revision <N> of quote <number> — update the quote first.`).
- `send_quote` does **not** send email (same as the simulator): it releases the quote. The email
  is `mail.send_message` with `attachments: [{"connector":"erp","kind":"quote-pdf","id":"<quote id>"}]`,
  a separate decision under `email` (scope `allowed_attachment_sources` must list `erp:quote-pdf`).
  See O6.

### 4.3 Quote PDF (template kind `quote`)

- New bundled template `templates/angebot-de.v1.json` with `"documents": ["quote"]`, resolved from
  a **separate** env `ERP_QUOTE_TEMPLATE` (default: the bundled file). The invoice template and
  its default (`rechnung-de.v4.json`) are not touched, so no issued-invoice rendering can move.
  A configured template whose `documents` lacks `quote` → `requireDocumentSupported` refusal
  (widen its `kind` type to `"invoice" | "credit_note" | "quote"`).
- `buildViewModel` gains `documentKind: "quote"` and `quoteOnly: {validUntil, revision}`; the
  variables tree adds `angebot: {nummer, gueltig_bis, revision}`; `rechnung` / `gutschrift` stay
  `undefined` for a quote. `zahlung`, `firma`, `kunde`, `positionen`, `summe`, `steuer` as for an
  invoice (`steuer.art` = the tax mode the quote would have **today**, derived like an invoice).
  Document `VARIABLES.md` additions in the template's own notes.
- Rendering goes through `renderInvoiceDocument` unchanged (same pdfmake path, creation date =
  `document_date` at UTC midnight) — R6. `preview_quote` and `send_quote` call one shared
  `renderQuote(revisionRow, documentDate, ctx)`; nothing reads "now".
- `send_quote` archives first, then (one transaction) sets `status='sent'`, `sent_at`,
  `document_date`, `archive_path`, `archive_sha256`, `template_*` on the quote row.

### 4.4 Quote → invoice (`create_invoice` with a quote)

`create_invoice` and `preview_invoice` gain `quote_id?` and `quote_revision?` (both or neither).
With them:

1. Quote must be `sent` and at `quote_revision` (else refused naming both revisions); not
   `converted` (one invoice per quote — refused naming the invoice number).
2. `customer_id` must equal the quote's customer.
3. `lines` may be omitted → copied from the quote revision (description, qty, unit, unit_price,
   vat_rate, item_id). If given, they are used as given (partial invoicing) and the card shows
   both the quote and the lines.
4. Everything else is the normal `create_invoice` path: `number` required (R7), `document_date`
   == today, `net_total` recomputed, tax mode derived from the customer's **current** tax data,
   `refuseIfInvalidTaxMode`, and `refuseIfVatContradictsTaxMode` (R8).
5. Same transaction as the invoice insert: quote `status='converted'`, `invoice_id` set;
   invoice row stores `quote_id`, `quote_revision`.

Governed as any invoice (invoicing · `invoice`); no new action type. The ticket binds
`quote_id` + `quote_revision` (v1 `jcs` binds the whole arguments), and a revision never changes,
so the approved content is fixed even when `lines` are omitted.

### 4.5 `get_document {kind: "quote-pdf", id}`

Accepts quote id or number. Refused for a quote that was never sent (`Quote Q-… is a draft —
there is no issued PDF; the card uses preview_quote.`). Verifies the archived sha256 exactly as for
invoices (`readAndVerify`). Returns `DOCUMENT_OUTPUT_SCHEMA`; filename `<number>-r<revision>.pdf`.

---

## 5. Part C — E3 catalogue (Local)

### 5.1 Item record

```jsonc
{ "id": "uuid", "sku": "string" | null, "name": "string", "description": "string" | null,
  "kind": "service" | "product", "unit": "Std." , "list_price": 120.0, "currency": "EUR",
  "vat_rate": 20, "active": true, "revision": 1, "stock": null,
  "created_at": "ISO", "updated_at": "ISO" }
```

Field names follow the simulator's `Item` (`list_price`, `sku`, `unit`, `currency`, `vat_rate`,
`stock`) so `list_items` / `get_item` answer the same shape in both modes; `stock` is always
`null` in Local (no inventory). The brief's `unit_price` for an item is `list_price` here — the
**line** keeps `unit_price`, which is exactly the pair the deviation check compares (see O7).

### 5.2 Tools

| Tool | Kind | Governs | Input | Notes |
|---|---|---|---|---|
| `list_items` | read (sim twin) | sales · read; also invoicing | `query?` (sku/name), `active?` (default `true`), `limit?` | |
| `get_item` | read (sim twin) | as above | `id`, `revision?` | inactive items are returned (old documents point at them) |
| `create_item` | write | invoicing · `item` | `name`, `kind`, `unit`, `list_price`, `vat_rate`, `sku?`, `description?`, `ticket_id` | `list_price` declared → `list_price_max` |
| `update_item` | write | invoicing · `item` | `id`, `revision`, any of `name`, `sku`, `unit`, `kind`, `description`, `active` | refuses `list_price` / `vat_rate`: `price and VAT rate are their own decision — use update_item_price` |
| `update_item_price` | write | invoicing · `item_price` | `id`, `revision`, `list_price`, `vat_rate` (both required) | refused if both equal the current values |

Refusals: `list_price` ≥ 0 and finite; `vat_rate` in 0–100; `sku` unique when set; `kind` in
the two values; `active:false` items are refused on **new** document lines
(`Item <sku|name> is inactive`), never on reading old ones.

### 5.3 Lines with `item_id` (invoices and quotes)

- Optional on every Local line (invoice, credit note, quote). When set: item must exist and be
  active; the connector stores `item_id` and the item's `list_price` and `revision` at that moment
  on the line row. Description, unit_price and vat_rate stay **explicit** on the line — the
  connector never fills them from the item (the card must show what is issued, not what the
  catalogue says).
- A line price that differs from the list price, or a line VAT rate that differs from the item's,
  is **not** refused (negotiated prices, reverse charge at 0 %). It is shown on the card by the
  manifest-declared deviation check (§7.3).

---

## 6. Database changes (`src/live/local/db.ts`)

Mechanism: the simulator's guarded pattern (`ADDED_COLUMNS` + `PRAGMA table_info` check before
`ALTER TABLE … ADD COLUMN`), plus `CREATE TABLE IF NOT EXISTS` for new tables. Additive only, no
column is dropped or retyped, every step idempotent, all of it at `createLocalDb` start inside one
transaction per step. A `local_schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT)` table
records the one data step (M-A2) so it runs exactly once. **`db.ts` has one owner: Part A** — B and
C hand their DDL to A as the blocks below (already final here), A lands all of it in PR A1.

| Id | Part | Change |
|---|---|---|
| M-A1 | A | `local_customers` + `crm_contact_id TEXT`, `revision INTEGER NOT NULL DEFAULT 1`, `updated_at TEXT`, `vies_status TEXT`, `vies_reason TEXT`, `vies_checked_at TEXT`, `vies_request_id TEXT`, `vies_name TEXT`, `vies_address TEXT`. Partial unique indexes: `ON local_customers(uid) WHERE uid IS NOT NULL`, `ON local_customers(crm_contact_id) WHERE crm_contact_id IS NOT NULL`. **Before creating the uid index, A checks for existing duplicate UIDs and, if any, skips the index and logs which ids collide** (the connector-level check in §3.3 still refuses new duplicates) — a demo DB must never fail to open. |
| M-A2 | A | `local_invoices` and `local_credit_notes` + `customer_name`, `customer_address_lines`, `customer_country`, `customer_uid`, `customer_revision`, `customer_snapshot_source`. Data step (once): fill from the current `local_customers` row (credit notes: from their invoice's snapshot), `customer_revision = 1`, source `'migrated'`. |
| M-A3 | A | `local_master_revisions (entity TEXT CHECK(entity IN ('customer','item')), entity_id TEXT, revision INTEGER, content TEXT /*JSON*/, ticket_id TEXT, created_at TEXT, PRIMARY KEY(entity, entity_id, revision))`. Backfill: revision 1 for every existing customer (content = current row). |
| M-A4 | A | `local_invoices` + `quote_id TEXT`, `quote_revision INTEGER`; `local_invoice_lines`, `local_credit_note_lines` + `item_id TEXT`, `list_price REAL`, `item_revision INTEGER` (all nullable — old rows stay null). |
| M-B1 | B (DDL via A) | `local_quote_numbers (number TEXT PRIMARY KEY, year INTEGER, seq INTEGER, quote_id TEXT, UNIQUE(year, seq))`; `local_quotes (id, number UNIQUE, customer_id REFERENCES local_customers, status CHECK IN ('draft','sent','converted','cancelled'), currency, discount_pct, net_total, valid_until, notes, revision, created_at, updated_at, sent_at, document_date, archive_path, archive_sha256, template_id, template_version, template_fingerprint, invoice_id, ticket_id)`; `local_quote_lines (id, quote_id, item_id, description, qty, unit, unit_price, vat_rate, list_price, item_revision, line_net)`; `local_quote_revisions (id, quote_id, revision, lines /*JSON*/, discount_pct, net_total, currency, valid_until, notes, customer_name, customer_address_lines, customer_country, customer_uid, customer_revision, ticket_id, created_at, UNIQUE(quote_id, revision))`. |
| M-C1 | C (DDL via A) | `local_items (id TEXT PRIMARY KEY, sku TEXT, name TEXT NOT NULL, description TEXT, kind TEXT CHECK(kind IN ('service','product')) NOT NULL, unit TEXT NOT NULL, list_price REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', vat_rate REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT)`; partial unique index on `sku`. Revisions go to `local_master_revisions` (entity `item`). |

Never touched: `local_numbers`, archive files, `archive_sha256`, `template_*` of issued rows, the
simulator DB. The CLI (`erp-mcp customers add|import`) keeps working and writes revision 1 + a
`local_master_revisions` row; it does **not** run VIES (the person typing it is the decision —
the stored `vies_status` stays null = "never checked", shown as such).

---

## 7. Profiles and manifest

### 7.1 `invoicing@0.2` (drafted: hap-profiles branch `feat/invoicing-0.2`, PR humanagencyprotocol/hap-profiles#19)

- `actionTypes`: `invoice`, `credit`, **`customer`**, **`customer_tax`**, **`item`**, **`item_price`**.
- New bounds (all `cumulative_count` daily with `appliesTo` = their one action type, except one):
  `customer_daily_max`, `customer_tax_daily_max`, `item_daily_max`, `item_price_daily_max`;
  `list_price_max` = `per_transaction` of `list_price`, `requiredFor: ["item_price"]`
  (`create_item` declares `list_price` too, so the cap applies there; `update_item` carries none).
- New execution-context fields: `list_price` (declared) and the four daily counts.
- `commitment_modes: ["review"]` (R2 — whole area, O1).
- `content_binding` stays `{"version":"1","kind":"jcs"}`: it hashes the **whole** arguments, so
  every tax-relevant field of `create_customer` / `update_customer_tax_data` / `update_item_price`
  is bound already, as are `quote_id` + `quote_revision` on conversion. A v2 field list would only
  narrow that and would have to enumerate every tool's fields; nothing gained.
- `read_access` covers the new reads (listed in `toolsDescription`). Invoice / credit limits unchanged.
- Validated: hap-core 0.12.1 `validateProfile` → `[]`; `content_binding` has no `appliesTo`
  (v1). The scope field `currency` keeps the retired top-level `enum` next to the new
  `constraint.values`, because the gateway's `BoundsEditor.tsx` still reads `enum` (O8).
- `sales` stays 0.4: `create_quote`/`update_quote` → `quote`, `send_quote` → `send`, unchanged bounds.

An `invoicing@0.1` mandate keeps working for invoices and credit notes until it expires; the
new write tools need a 0.2 mandate (R2). The gateway must offer 0.2 for new invoicing mandates as
soon as the profile is on `main` — **profile and gateway 0.38.0 merge together** (suveren.ai serves
profiles live from `main`).

### 7.2 Generic gateway mechanisms Part D adds (none names a profile or vendor)

Facts from the gateway today (0.37.0, `apps/mcp-server/src/lib/tool-gating-types.ts`,
`apps/ui/src/components/ApprovalBody.tsx`): the card's checks line is built only from profile
`per_transaction` bounds and attachment checks (`LimitCheckLike {key,label,ok,valueText,limitText}`,
`ok` boolean — no "not checked" state); preview results go only to the preview box; there is no
manifest `checks` key (an unknown key loads and is ignored); one tool maps to one
`staticExecution.action_type`. So D adds three generic things:

**D1 — `checks` on a tool override.** Evaluated by the gateway over the call's arguments plus the
attached preview results (same path grammar as `display`: `a`, `a.b`, `a[].b`, `a[].attach.b`),
appended to the checks line after the limit checks. Results are system-derived (they read
connector answers the gateway fetched itself); the AI cannot supply one.

```ts
interface CheckDeclaration {
  key: string;                     // unique per tool
  label: string;                   // ≤ 80 chars, spec wording
  path: string;                    // value under test
  when?: string;                   // check applies only if this path is present (non-null, non-empty)
  forEach?: string;                // array arg: one entry per element (index in detail as {#})
  // either value-matching …
  pass?: Array<string|number|boolean>; fail?: Array<…>; notice?: Array<…>; notChecked?: Array<…>;
  // … or a comparison
  compare?: { op: 'eq' | 'ne' | 'gt' | 'lt'; to: string /* path */ | number };
  onTrue?: CheckStatus; onFalse?: CheckStatus;   // for compare; defaults pass / fail
  missing?: 'skip' | 'not_checked';              // path absent or preview unavailable; default skip
  detail?: string;                 // summary grammar ({path|money} …), rendered after the label
}
type CheckStatus = 'pass' | 'fail' | 'notice' | 'not_checked';
```

Rendering (needs a UI-spec change with Andreas's sign-off and an HTML mockup **before** code —
`.claude/rules/suveren-ui-spec.md`): `pass` ✓; `fail` ✕ bold red (the only red); `not_checked`
"–" monochrome + reason ("not checked: VIES unreachable"); `notice` monochrome, no mark (an
informational line, e.g. a price deviation). `LimitCheckLike` gains `status` (keeps `ok` for old
callers). A value that matches no list → `not_checked` with "unexpected value" (fail-visible, never
silently pass). Load-time validation in `manifest-loader.ts`: unknown key, bad path grammar,
neither/both forms, > 12 checks per tool → manifest refused.

**D2 — `when` on a preview read; absent optional args omitted.** `PreviewReadConfig` gains
`when?: string` (an argument path; inside `forEach`, an element field): when it is absent the read
is not called and attaches nothing (`create_customer` without `uid`, a quote line without
`item_id`, an invoice without `quote_id`). A mapped argument that is absent is **omitted** from
the read's arguments, never sent as `null`. Today's behaviour must be checked and both rules pinned
by tests.

**D3 — `network` declaration (top-level manifest key) for outside calls (R5).**

```ts
interface NetworkDeclaration { modes?: Record<string, string[] | true>; host: string; purpose: string; sends: string; }
```
Shown on the connector's settings page under the mode it applies to ("Asks <host> — <purpose>.
Sends: <sends>."). The gateway does not proxy or police the call; it makes the promise visible.

### 7.3 `erp.json` changes (concrete; Part D owns the file)

Top level — version pin, credentials, mode note, outside call, document kind:

```jsonc
"npmVersion": "0.10.0",
// credentials.fields: append
{ "key": "quoteTemplate", "label": "Quote template (optional)", "type": "text",
  "placeholder": "Path to a quote template file — leave empty for the bundled German template", "optional": true },
{ "key": "viesCheck", "label": "VAT-ID check (optional)", "type": "text",
  "placeholder": "on (default) — \"off\" saves every VAT ID as not checked", "optional": true },
// credentials.envMapping: add
"ERP_QUOTE_TEMPLATE": "quoteTemplate", "ERP_VIES": "viesCheck",
"modeNotes": { "live": { "local": "On this computer. VAT-ID checks ask the EU VIES service." } },
"network": [
  { "modes": { "live": ["local"] }, "host": "ec.europa.eu",
    "purpose": "EU VAT-ID check (VIES) when a customer's VAT ID is saved or shown for approval",
    "sends": "the customer's country and VAT ID, and your own VAT ID" }
],
"documents": {
  "invoice-pdf": { /* unchanged */ }, "credit-note-pdf": { /* unchanged */ },
  "quote-pdf": { "tool": "get_document", "args": { "kind": "quote-pdf", "id": "$id" }, "label": "sent quote {id}" }
}
```

Reads — add `readAlsoUnder` (reads only, R9) and the new internal reads:

```jsonc
"list_items":  { "readAlsoUnder": ["invoicing"], "category": "read", "boundField": "read_access", "requiredValue": "unlimited" },
"get_item":    { "readAlsoUnder": ["invoicing"], "category": "read", "boundField": "read_access", "requiredValue": "unlimited" },
"list_quotes": { "readAlsoUnder": ["invoicing"], "category": "read", "boundField": "read_access", "requiredValue": "unlimited" },
"get_quote":   { "readAlsoUnder": ["invoicing"], "category": "read", "boundField": "read_access", "requiredValue": "unlimited" },
"check_vat_id":            { "profile": "invoicing", "category": "read", "internal": true },
"preview_customer_change": { "profile": "invoicing", "category": "read", "internal": true },
"preview_quote":           { "category": "read", "internal": true }
```

Customer writes:

```jsonc
"create_customer": {
  "profile": "invoicing",
  "summary": "New customer {name}, {country}[ — VAT ID {uid}]",
  "executionMapping": {},
  "staticExecution": { "action_type": "customer" },
  "actionLabel": "Customer created",
  "preview": [ { "tool": "check_vat_id", "args": { "country": "country", "uid": "uid" }, "attach": "uid", "when": "uid" } ],
  "checks": [
    { "key": "vat-format", "label": "VAT ID format", "when": "uid", "path": "uid.format",
      "pass": ["ok", "not_applicable"], "fail": ["wrong_prefix", "wrong_pattern"], "missing": "not_checked" },
    { "key": "vies", "label": "VAT ID confirmed by VIES", "when": "uid", "path": "uid.vies.status",
      "pass": ["valid"], "fail": ["invalid"], "notChecked": ["not_checked"], "missing": "not_checked",
      "detail": "[{uid.vies.reason} — saving is not blocked while VIES is unreachable]" },
    { "key": "duplicate", "label": "No other customer with this VAT ID", "when": "uid",
      "path": "uid.duplicate", "pass": [false], "fail": [true], "missing": "skip",
      "detail": "[already customer {uid.duplicate_of}]" }
  ],
  "display": {
    "order": ["name", "address_lines", "country", "uid", "email", "crm_contact_id"],
    "labels": { "name": "Name", "address_lines": "Address", "country": "Country", "uid": "VAT ID",
                "email": "Email", "crm_contact_id": "CRM contact",
                "uid.vies.name": "Name at VIES", "uid.vies.address": "Address at VIES" },
    "hidden": ["uid.format", "uid.vies.status", "uid.vies.reason", "uid.duplicate", "uid.duplicate_of", "uid.vies.request_id"]
  }
},
"update_customer": {
  "profile": "invoicing",
  "summary": "Change contact data of customer {id}",
  "executionMapping": {},
  "staticExecution": { "action_type": "customer" },
  "actionLabel": "Customer updated",
  "preview": [ { "tool": "get_customer", "args": { "id": "id", "revision": "revision" }, "attach": "id",
                 "version": { "arg": "revision", "field": "revision" } } ],
  "display": { "order": ["id", "email", "crm_contact_id"],
               "labels": { "id": "Customer", "email": "Email (new)", "crm_contact_id": "CRM contact (new)",
                           "id.email": "Email (now)", "id.crm_contact_id": "CRM contact (now)" } }
},
"update_customer_tax_data": {
  "profile": "invoicing",
  "summary": "Change tax data of customer {id}: {name}, {country}[ — VAT ID {uid}]",
  "executionMapping": {},
  "staticExecution": { "action_type": "customer_tax" },
  "actionLabel": "Customer tax data changed",
  "preview": [ { "tool": "preview_customer_change",
                 "args": { "id": "id", "name": "name", "address_lines": "address_lines", "country": "country", "uid": "uid" },
                 "attach": "id", "version": { "arg": "revision", "field": "revision" } } ],
  "checks": [
    { "key": "vies", "label": "New VAT ID confirmed by VIES", "when": "uid", "path": "id.vat_check.vies.status",
      "pass": ["valid"], "fail": ["invalid"], "notChecked": ["not_checked"], "missing": "not_checked",
      "detail": "[{id.vat_check.vies.reason} — saving is not blocked while VIES is unreachable]" },
    { "key": "duplicate", "label": "No other customer with this VAT ID", "when": "uid",
      "path": "id.vat_check.duplicate", "pass": [false], "fail": [true], "missing": "skip" },
    { "key": "tax-mode", "label": "Tax treatment of future invoices", "path": "id.tax_mode.after",
      "compare": { "op": "eq", "to": "id.tax_mode.now" }, "onTrue": "pass", "onFalse": "notice",
      "detail": "{id.tax_mode.now} → {id.tax_mode.after}" },
    { "key": "already-invoiced", "label": "Already issued to this customer", "when": "id.uid_or_country_changed",
      "path": "id.issued_documents.invoices", "compare": { "op": "gt", "to": 0 }, "onTrue": "notice", "onFalse": "pass",
      "detail": "{id.issued_documents.invoices} invoices, {id.issued_documents.credit_notes} credit notes — they keep the old data" }
  ],
  "display": {
    "order": ["id", "name", "address_lines", "country", "uid"],
    "labels": { "id": "Customer", "name": "Name (new)", "address_lines": "Address (new)", "country": "Country (new)",
                "uid": "VAT ID (new)", "id.current.name": "Name (now)", "id.current.address_lines": "Address (now)",
                "id.current.country": "Country (now)", "id.current.uid": "VAT ID (now)",
                "id.open_quotes": "Open quotes (must be updated before sending)" },
    "hidden": ["id.vat_check", "id.tax_mode", "id.issued_documents", "id.changed", "id.revision", "id.uid_or_country_changed", "id.current.revision"]
  }
},
"create_invoice": {
  // unchanged: profile, summary, executionMapping, staticExecution, actionLabel, contextKeys
  "preview": [
    { "tool": "get_customer", "args": { "id": "customer_id", "revision": "customer_revision" }, "attach": "customer_id",
      "version": { "arg": "customer_revision", "field": "revision" } },
    { "tool": "get_quote", "args": { "id": "quote_id", "revision": "quote_revision" }, "attach": "quote_id", "when": "quote_id",
      "version": { "arg": "quote_revision", "field": "revision" } },
    { "tool": "get_item", "forEach": "lines", "args": { "id": "item_id" }, "attach": "item", "when": "item_id" },
    { "tool": "preview_invoice",
      "args": { "customer_id": "customer_id", "number": "number", "document_date": "document_date",
                "service_period": "service_period", "lines": "lines", "net_total": "net_total", "currency": "currency",
                "payment_term_days": "payment_term_days", "memo": "memo",
                "quote_id": "quote_id", "quote_revision": "quote_revision", "customer_revision": "customer_revision" },
      "kind": "document" }
  ],
  "checks": [
    { "key": "vies", "label": "Customer VAT ID confirmed by VIES", "when": "customer_id.uid",
      "path": "customer_id.vies.status", "pass": ["valid"], "fail": ["invalid"], "notChecked": ["not_checked", null],
      "missing": "not_checked",
      "detail": "[checked {customer_id.vies.checked_at|date}][ — {customer_id.vies.reason}][ — issuing is not blocked without a VIES confirmation]" },
    { "key": "list-price", "label": "Line price = list price", "forEach": "lines", "when": "lines[].item_id",
      "path": "lines[].unit_price", "compare": { "op": "eq", "to": "lines[].item.list_price" },
      "onTrue": "pass", "onFalse": "notice",
      "detail": "line {#}: {lines[].unit_price|money} — list price {lines[].item.list_price|money}" },
    { "key": "item-vat", "label": "Line VAT = item VAT rate", "forEach": "lines", "when": "lines[].item_id",
      "path": "lines[].vat_rate", "compare": { "op": "eq", "to": "lines[].item.vat_rate" },
      "onTrue": "pass", "onFalse": "notice",
      "detail": "line {#}: {lines[].vat_rate|percent} — item {lines[].item.vat_rate|percent}" }
  ],
  "display": {
    // add to order after "customer_id": "quote_id", "quote_revision", "customer_revision"
    // add money: "lines[].item.list_price", "quote_id.net_total"
    // add labels: "quote_id": "Quote", "quote_revision": "Quote revision", "customer_revision": "Customer revision",
    //   "lines[].item": "Item", "lines[].item.list_price": "List price",
    //   "customer_id.uid": "VAT ID", "customer_id.vies.checked_at": "VIES checked"
    // hidden: "customer_id.vies.status", "customer_id.vies.reason", "customer_id.vies.request_id"
  }
},
// create_credit_note: unchanged (the credit note renders the invoice's snapshot, R1).
"create_quote": {
  // unchanged: summary, executionMapping (value/discount_pct/currency), staticExecution quote, actionLabel, contextKeys
  "preview": [
    { "tool": "get_customer", "args": { "id": "customer_id" }, "attach": "customer_id" },
    { "tool": "get_item", "forEach": "lines", "args": { "id": "item_id" }, "attach": "item", "when": "item_id" }
  ],
  "checks": [ /* "list-price" and "item-vat" exactly as on create_invoice; in simulation lines have no
                 unit_price, so `list-price` reads missing → skip (missing: "skip" is the default) */ ],
  "display": {
    // add to order/labels: "lines[].description", "lines[].unit_price" (money), "lines[].vat_rate" (percent),
    //   "lines[].item.vat_rate": "Item VAT rate", "customer_id.uid": "VAT ID"
  }
},
"update_quote": {
  "preview": [
    { "tool": "get_quote", "args": { "id": "id", "revision": "revision" }, "attach": "id", "when": "revision",
      "version": { "arg": "revision", "field": "revision" } },
    { "tool": "get_item", "forEach": "lines", "args": { "id": "item_id" }, "attach": "item", "when": "item_id" }
  ],
  "checks": [ /* "list-price" and "item-vat" as above */ ]
},
"send_quote": {
  // unchanged: summary, executionMapping, staticExecution send, actionLabel, contextKeys
  "preview": [
    { "tool": "get_quote", "args": { "id": "id", "revision": "revision" }, "attach": "id",
      "version": { "arg": "revision", "field": "revision" },
      "fields": ["number", "revision", "status", "customer_id", "customer", "lines", "net_total", "discount_pct", "valid_until"] },
    { "tool": "preview_quote", "args": { "id": "id", "revision": "revision", "document_date": "document_date" },
      "kind": "document", "when": "document_date" }
  ]
},
"convert_quote_to_order": { /* unchanged — simulation only in practice; Local refuses it (§4.2) */ },

"create_item": {
  "profile": "invoicing",
  "summary": "New item {name} at {list_price|money} per {unit}, VAT {vat_rate|percent}",
  "executionMapping": { "list_price": "list_price" },
  "staticExecution": { "action_type": "item" },
  "actionLabel": "Item created",
  "display": { "order": ["name", "kind", "unit", "list_price", "vat_rate", "sku", "description"],
               "money": ["list_price"], "percent": ["vat_rate"],
               "labels": { "name": "Name", "kind": "Kind", "unit": "Unit", "list_price": "List price (net)",
                           "vat_rate": "VAT rate", "sku": "Item number", "description": "Description" } }
},
"update_item": {
  "profile": "invoicing",
  "summary": "Change item {id}",
  "executionMapping": {},
  "staticExecution": { "action_type": "item" },
  "actionLabel": "Item updated",
  "preview": [ { "tool": "get_item", "args": { "id": "id", "revision": "revision" }, "attach": "id",
                 "version": { "arg": "revision", "field": "revision" } } ],
  "display": { "labels": { "id": "Item", "active": "Active" } }
},
"update_item_price": {
  "profile": "invoicing",
  "summary": "Price of item {id}: {list_price|money}, VAT {vat_rate|percent}",
  "executionMapping": { "list_price": "list_price" },
  "staticExecution": { "action_type": "item_price" },
  "actionLabel": "Item price changed",
  "preview": [ { "tool": "get_item", "args": { "id": "id", "revision": "revision" }, "attach": "id",
                 "version": { "arg": "revision", "field": "revision" } } ],
  "checks": [
    { "key": "price-change", "label": "List price", "path": "list_price", "compare": { "op": "eq", "to": "id.list_price" },
      "onTrue": "pass", "onFalse": "notice", "detail": "{id.list_price|money} → {list_price|money}" },
    { "key": "vat-change", "label": "VAT rate", "path": "vat_rate", "compare": { "op": "eq", "to": "id.vat_rate" },
      "onTrue": "pass", "onFalse": "notice", "detail": "{id.vat_rate|percent} → {vat_rate|percent}" }
  ],
  "display": { "money": ["list_price", "id.list_price"], "percent": ["vat_rate", "id.vat_rate"],
               "labels": { "id": "Item", "list_price": "List price (new)", "id.list_price": "List price (now)",
                           "vat_rate": "VAT rate (new)", "id.vat_rate": "VAT rate (now)" } }
}
```

`mail.json` needs **no change**: `quote-pdf` is reachable through the existing
`attachments` / `attachmentsArg` mechanism once `erp.json` declares the document kind; the
mandate's `allowed_attachment_sources` must list `erp:quote-pdf` (email@0.9 scope).

---

## 8. Test plan

Fast tests run with no network: VIES is a local HTTP stub (`ERP_VIES_URL`), answering valid /
invalid / 503 / hang (timeout) / `MS_UNAVAILABLE` by VAT ID. One opt-in live VIES test
(`ERP_VIES_LIVE=1`, a known-valid public VAT ID) is never part of CI.

**Part A** (`test/live-local/`)
- `customers-write.test.ts`: create → revision 1 + `local_master_revisions` row; update tools → next
  revision; stale revision refused naming both (R11); `update_customer` with a tax field refused;
  identical tax data refused; old revision readable.
- `vat-id.test.ts`: every EU state + `XI` + `GR`→`EL`: good / wrong prefix / wrong pattern; non-EU passes as `not_applicable`.
- `vies.test.ts`: stub valid → stored `valid` + request id; invalid → refused, nothing saved;
  503 / timeout / `MS_UNAVAILABLE` → saved `not_checked` with reason (R5); `ERP_VIES=off`; requester
  refused → retried without; preview vs execution disagreement → execution result stored.
- `customers-idempotent.test.ts`: same `crm_contact_id` / same `uid` → second refused naming the first (R10).
- `live-local-snapshot.test.ts` (R1) and `migration-local.test.ts` (R12): a fixture DB written by
  0.9.5 code (checked in as SQL) opens, gets snapshots marked `migrated`, every archived PDF still
  verifies, second open is a no-op, duplicate-UID fixture opens with the index skipped.
- `preview-customer-change.test.ts`: `changed`, `tax_mode.now/after`, `issued_documents` (R4).
- `dispatch.test.ts` (existing): tool list from the registry; CLI `customers add` writes revision 1.

**Part B**
- `quotes.test.ts`: state machine, revision rule, `discount_pct ≠ 0` refused, own number series
  (never touches `local_numbers`) (R7), customer changed since revision → `send_quote` refused,
  `send_quote` date ≠ today refused.
- `quote-pdf.test.ts` (R6): preview sha == archived sha for the same revision; two renders
  identical; template without `quote` refused; invoice PDFs byte-identical before/after B.
- `quote-convert.test.ts`: lines copied; stale `quote_revision` refused; second conversion refused;
  missing `number` / wrong date refused (R7); 20 % lines + reverse-charge customer refused (R8);
  quote `converted` and invoice `quote_id` in one transaction (failure → neither).
- `get-document-quote.test.ts`: draft refused; tampered archive refused.

**Part C**
- `items.test.ts`: create / update / update_item_price, revision rule, price fields refused on
  `update_item`, unchanged price refused, unique `sku`, inactive item refused on a new line but
  readable; line rows store `item_id`, `list_price`, `item_revision`; line price ≠ list price accepted.

**Part D** (gateway, `apps/mcp-server` + `apps/ui` vitest)
- `checks.test.ts`: each form (value lists, compare, `forEach`, `when`, `missing`), unknown value →
  `not_checked`, AI-supplied args can never satisfy a check that reads a preview path.
- `manifest-loader` tests: `checks` / `network` / preview `when` validation; R9 lint (no
  `readAlsoUnder` on a write); erp.json loads.
- `preview` tests: `when` skips the read; absent optional args omitted (D2).
- UI: checks line renders the four statuses (only `fail` red); network note on the connector page.
- hap-e2e `test/erp-local-production.test.ts` (real erp-mcp in Local mode + VIES stub, real gateway,
  real AS): automatic mandate under `invoicing@0.2` refused (R2); `create_customer` under an 0.1
  mandate refused; review flow for each new write with the card's checks present; quote → send →
  email with `erp:quote-pdf` attachment sealed; quote → invoice; customer tax change between
  approval and execution → execution refused (preview version / AU4 hash).

---

## 9. Parts, file ownership, order

A file has exactly one owner. Others do not edit it; they ask the owner (or wait for the owner's
merge and branch from it). **A1 is the only serial step**: B and C branch from A1's merge.

| Part | Branch / repo | Owns (may edit) |
|---|---|---|
| **0 — contract** | this file, `docs/contract.md` | coordinator only |
| **A1 — scaffold + DB + snapshot** (first, small) | hap-erp-mcp `feat/local-a1-snapshot` | `src/live/local/db.ts` (all DDL of §6 incl. B/C blocks), `src/live/local/tools/invoices.ts` (snapshot, `customer_revision`, writes the new line columns from whatever `lines.ts` returns), new `src/live/local/lines.ts` (moves `validateLocalLines` out of invoices.ts unchanged; returns `item_id/list_price/item_revision` = null for now), `src/live/local/dispatch.ts` + `definitions.ts` (turned into a registry merging per-area maps; creates **empty** `definitions-quotes.ts`, `definitions-items.ts`, `tools/quotes.ts`, `tools/items.ts` stubs), `test/live-local/fixtures.ts`, `test/live-local/dispatch.test.ts`, `test/live-local/mcp-output-schema.test.ts`, migration fixture |
| **A2 — customers + VIES** | `feat/local-a2-customers` | `src/live/local/tools/customers.ts`, new `vat-id.ts`, `vies.ts`, customer entries in `definitions.ts` / `dispatch.ts`, `src/cli.ts`, `src/live/local/company-file.ts` (none expected), A's tests |
| **B — quotes** | `feat/local-b-quotes` | `src/live/local/tools/quotes.ts`, `definitions-quotes.ts`, `view-model.ts`, `template.ts`, `templates/angebot-de.v1.json`, `archive.ts` (quote path helper), **the quote-conversion block of `tools/invoices.ts`** (after A1 merged; A does not touch invoices.ts after A1), B's tests |
| **C — catalogue** | `feat/local-c-items` | `src/live/local/tools/items.ts`, `definitions-items.ts`, `lines.ts` (after A1), C's tests |
| **D — gateway** | suveren-gateway `feat/erp-local-production` | `content/integrations/erp.json`, `apps/mcp-server/src/lib/{tool-gating-types,manifest-loader,integration-manager,integration-registry,preview}.ts`, new `apps/mcp-server/src/lib/checks.ts`, `apps/ui/src/lib/{receipt-summary,attachment-sealed}.ts`, `apps/ui/src/components/ApprovalBody.tsx`, the connector settings component that renders `modeNotes`, `suveren-as/docs/ui-spec/*` (**spec change first, with Andreas's sign-off**), hap-e2e test |
| **Profiles** | hap-profiles `feat/invoicing-0.2` (drafted) | `invoicing/0.2.profile.json`, `index.json` |
| **Release** | coordinator | `package.json` version, `CHANGELOG.md`, `README.md` (each part writes its notes in its PR body) |

Release order: erp-mcp 0.10.0 on npm (A1+A2+B+C merged) → gateway 0.38.0 pins it (`npmVersion`)
**and** the profile PR merge together (suveren.ai serves profiles live from `main`) → hap-e2e green on
CI runs that started after both merges. Andreas tests the gateway build before publish.

---

## 10. Open decisions (Andreas)

The contract picks a default for each so work can start; changing one is a contract change.

| # | Question | Default here | Cost of the default |
|---|---|---|---|
| O1 | Review-only for customer writes (R2): the protocol has commitment modes per **profile**, not per action type. | `invoicing@0.2` is review-only as a whole. | No automatic invoicing under 0.2. Per-action modes would be new protocol vocabulary → `content/0.7/review.md` ledger. |
| O2 | Is the customer's **name** tax data? | Yes (mandatory invoice content). | A name typo fix is a `customer_tax` decision. |
| O3 | Reverse-charge invoice for a customer whose VAT ID is `not_checked`. | Not blocked; the card says so. | Relies on the person reading the line. Blocking = refuse in `refuseIfInvalidTaxMode` unless `vies.status = valid`. |
| O4 | Document discount on Local quotes. | `discount_pct` must be 0; prices per line. | Needs a discount line on invoices to change. |
| O5 | Quote numbers. | Connector-assigned `Q-YYYY-NNNN`, own series. | Not the person's own format. |
| O6 | Sending a quote = `send_quote` (sales · send) **and** an email (email · send): two decisions. | Two. | Two approvals per quote; "sent" means released, even if the email is then rejected. |
| O7 | Item price field name. | `list_price` (simulator name; the line keeps `unit_price`). | Differs from the brief's `unit_price`. |
| O8 | `currency` scope keeps the retired top-level `enum` next to `constraint.values`. | Keep (gateway `BoundsEditor.tsx` reads `enum`). | Profile-compliance check "no `field.enum`" stays red as in 0.1; fix = UI reads `constraint.values`, drop `enum` in 0.3. |
| O9 | Two customers with one VAT ID (branches). | Refused. | Branches need one customer record. |
| O10 | Checks line gets `not_checked` and `notice` states. | As §7.2 D1. | UI-spec change + HTML mockup + sign-off **before** D's UI code. |
| O11 | VIES at execution may differ from the card. | Re-check at execution; `invalid` refuses; stored = execution result. | The stored status can differ from what the card showed; it is never `valid` unless VIES said so at execution. |
| O12 | `cancel_quote`. | Not in 0.10.0 (as the simulator). | A wrong sent quote stays `sent`. |

## 11. Amendments from review (ERP author session, 2026-10-21) — binding

| # | Change | Owner | Test |
|---|--------|-------|------|
| AM1 | **VIES on the card is display-only.** The card's `check_vat_id` read carries volatile fields (`checked_at`, `request_id`, status may flip), so it must NOT take part in the AU4 changed-check (proposal hash vs re-read before execution). Generic manifest declaration on the preview read marks it display-only; the card labels it with its time. `create_customer` / `update_customer_tax_data` re-run VIES at execution and store THAT result (O11). | D (declaration + test), A2 (re-check at execution) | gateway: a create_customer approval survives a second VIES call with a new `request_id` and a status flip |
| AM2 | **Conversion refuses a changed customer.** If the customer's current revision differs from the quote revision's snapshot `customer_revision`, `create_invoice` with `quote_id` is refused, naming both revisions (mirrors `send_quote`). R8 alone is not enough: a quote to a normal-VAT customer must not convert into a reverse-charge invoice. | B | conversion after a customer tax-data change → refused with both revisions |
| AM3 | **Migration snapshot wording.** For invoices issued before the migration, the archived PDF (write-once, sha-verified) stays the legal original; the `migrated` snapshot is a best-effort copy taken at migration time. Credit notes on pre-migration invoices render the migrated snapshot. | A1 (doc + migration comment) | — |
| AM4 | **O3 / O5 for Andreas:** the reviewer recommends refusing to ISSUE a reverse-charge invoice unless the customer's last VIES result is `valid` (saving a not-checked customer stays allowed). O5: connector-assigned quote numbers differ from the invoice rule "the number comes with the request" — decision pending with Andreas. | Coordinator | — |

## 12. Andreas's decisions (2026-10-21) — binding, supersede the defaults above

| # | Decision |
|---|----------|
| D1 (O3/AM4) | A reverse-charge invoice (and a reverse-charge credit note / quote conversion) is **issued only if the customer's last stored VIES result is `valid`**; otherwise refused: "confirm the VAT ID first". Saving a customer whose VAT ID is `not checked` stays allowed. |
| D2 (O5) | **Quote numbers come with the request, from the agent — like invoices.** Separate series from invoices/credit notes (e.g. `<PREFIX>-A-YYYY-NNN`, format set by the brief), the connector refuses a used number and a malformed one; `document_date` rules as for invoices. No connector-assigned numbers. |
| D3 (O6) | **Quotes work like invoices: no separate `send_quote` approval step in Local.** Create quote (Sales mandate) → email with the quote PDF by reference (email mandate). The quote's status becomes `sent` when the email carrying its PDF is executed (ticket-linked) — or is not tracked; pick the simpler correct one and say which. Whether each step needs an approval is decided by each mandate's mode, never by the process. |
| D4 (O1) | **Open** — question to Andreas: customer master data + catalogue in their OWN area (review-only, e.g. "Customer master data"), Invoicing unchanged (automatic still possible) — recommended, standard segregation of duties — vs. review-only for all of Invoicing 0.2. Profile work waits for this answer. |
