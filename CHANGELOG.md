# Changelog

## Unreleased

**BREAKING:** quote revisions. Every quote carries an integer `revision`,
starting at 1; `create_quote` always produces revision 1, and every
successful `update_quote` produces the next one. `send_quote` and
`convert_quote_to_order` now take a **required** `revision` argument and are
refused — naming both revisions — if the quote is no longer at the revision
the caller declared. A caller must read the quote's current revision
(`create_quote`, `update_quote`, or `get_quote` all return it) and pass it
back; the gateway's content binding and review-mode proposal matching already
cover arbitrary new arguments like this one generically, so this needs no
per-field change there.

New table `quote_revisions` holds a frozen snapshot of each revision's content
(lines, discount, net total, currency, validity date, notes). `get_quote`
accepts an optional `revision` argument to read an older one instead of the
current version. Existing SQLite and Postgres databases are migrated in place
on first start after upgrading (`quotes.revision` defaults to 1; a snapshot is
backfilled for every existing quote) — safe to run repeatedly, including
against a database already on this version.

See [`docs/contract.md`](docs/contract.md) for the full rule.

`get_quote` additionally declares an MCP `outputSchema` (human, vendor-neutral
`title`/`description` per field, naming `revision` and `status` as required)
and its result now carries `structuredContent` alongside the usual text
content — so `revision`/`status` can be read generically by a caller that
uses structured tool output, not just by parsing JSON out of a text block.
Every other tool is unchanged (no outputSchema, no structuredContent).

## 0.5.0

**BREAKING:** the tool argument `receipt_id` is now `ticket_id` (HAP v0.7
vocabulary); the Suveren gateway fills it — use gateway v0.7 or later.

This is a breaking change on the wire, released as a minor by the owner's
decision (pre-1.0, one implementation). Internal SQLite storage is unaffected:
the `receipt_id` column name on the `quotes`, `orders`, `changes`, and
`refusals` tables is unchanged — it now stores the value supplied under the
`ticket_id` argument.
