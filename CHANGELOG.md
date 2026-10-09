# Changelog

## 0.5.0

**BREAKING:** the tool argument `receipt_id` is now `ticket_id` (HAP v0.7
vocabulary); the Suveren gateway fills it — use gateway v0.7 or later.

This is a breaking change on the wire, released as a minor by the owner's
decision (pre-1.0, one implementation). Internal SQLite storage is unaffected:
the `receipt_id` column name on the `quotes`, `orders`, `changes`, and
`refusals` tables is unchanged — it now stores the value supplied under the
`ticket_id` argument.
