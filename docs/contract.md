# ERP connector contract

This describes the contract this connector keeps with any caller — the tools,
their arguments, and the refusal rules — independent of what runs behind it
(a simulated database today; a real ERP system behind a live adapter later).
It is vendor-neutral by design: nothing here names a product, a specific
governance layer, or a gating mechanism. A caller only needs this document and
the tool list the server advertises.

## The revision rule

This section states the rule independent of what kind of record it applies
to — it is the same rule for any record type a connector exposes through this
kind of contract, not something particular to a quote. See *Quotes and the
revision rule* below for how this connector's one record type (the quote)
applies it.

A record that can be changed after creation, and that a caller later acts on
by name (sends it, converts it, commits it — anything beyond reading it),
carries an integer **revision**, starting at 1:

- **Any change to the record's content creates the next revision.** Creation
  is revision 1. Every change that succeeds afterward produces the next
  integer — regardless of whether the change looks material (two different
  sets of content at the same total, or the same aggregate value, still
  produce a new revision; the revision tracks the record's actual content,
  not a derived number like a total).
- **A revision, once created, never changes.** Its content is frozen the
  moment the next revision exists. A caller can always retrieve a past
  revision by number.
- **An action that acts on the record's content names the revision it acts
  on.** It takes a `revision` argument and is refused if the record is no
  longer at that revision. This is what makes a request like "send this" or
  "convert this" bind to one exact version of the record's content, even if
  the record changed between the moment the request was made (and perhaps
  decided on by a person) and the moment it was actually carried out.
- **A revision mismatch is refused by naming both revisions** — the one the
  caller declared and the record's actual current one — the same way every
  other declared-value mismatch is refused in this connector (see *Refusal
  shape* below). Nothing about the record changes when this refusal happens.
- **Old revisions are kept.** Nothing a caller can do erases an earlier
  revision's content.

This follows ordinary optimistic-locking practice (compare-and-refuse on a
version number) and is not unusual among ERP systems: a release on a business
document is tied to the document version it was given at the time, and a
later edit resets it.

## Quotes and the revision rule

This connector's one record type that carries a revision is the **quote**.
It moves through a fixed set of statuses:

```
draft --(send)--> sent --(convert)--> converted
  |
  +--(cancel)--> cancelled
```

- A quote is created in `draft`.
- Only a `draft` quote can be changed (`update_quote`) or sent (`send_quote`).
- A `sent` quote can be converted to an order (`convert_quote_to_order`), or
  cancelled.
- `converted` and `cancelled` are terminal: nothing changes a quote once it
  reaches either.
- **A sent quote never changes in place.** There is no tool that edits the
  content of a quote once it has been sent.
- **Quotes are cancelled, never deleted.** There is no delete tool for a
  quote, sent or not. A mistaken or abandoned quote is cancelled, not removed
  — the record of what was once offered stays.

Applying the general rule above: `create_quote` always produces revision 1;
every successful `update_quote` produces the next revision. `send_quote` and
`convert_quote_to_order` both require a `revision` argument and are refused,
naming both revisions, if the quote is no longer at that revision.

An **order** is created once, by converting a sent quote. It has no separate
revision history of its own: it is a snapshot of the quote at the moment of
conversion, and nothing changes it afterward.

## Tools

### Reads

| Tool | Returns |
|---|---|
| `list_items`, `get_item` | catalog items |
| `find_customers`, `get_customer` | customers, incl. credit limit and open balance |
| `list_quotes` | quotes, each including its current `revision` |
| `get_quote` | a quote with its lines, including `revision`; an optional `revision` argument returns that exact historical version instead of the current one |
| `list_orders`, `get_order` | orders |

### Changes

| Tool | Effect | Revision |
|---|---|---|
| `create_quote` | creates a quote in `draft` | produces revision 1 |
| `update_quote` | replaces a draft quote's content | produces the next revision |
| `send_quote` | `draft` → `sent` | requires the current `revision`; refused otherwise |
| `convert_quote_to_order` | `sent` → `converted`, creates an order | requires the current `revision`; refused otherwise |

Every change tool recomputes the document's net total from its lines and the
declared discount, and refuses the call outright if the caller's declared
`value`, `discount_pct`, or `currency` does not match — the declaration is
the only thing a governing layer outside this connector can see, so it must
always equal what the connector is about to do. The revision argument
extends the same principle from a quote's total to its whole content: a
caller requesting an action on a quote names one exact version of that
document, not "whatever that quote currently contains".

## How a caller learns the current revision

The revision of a quote is always in the result of whichever call most
recently touched or read it: `create_quote`, `update_quote`, `get_quote`, and
`list_quotes` all include it. A caller preparing a `send_quote` or
`convert_quote_to_order` call reads the quote first (or uses the revision
returned by the call that produced the version it intends to act on) and
passes that number back.

## Refusal shape

Every refusal in this connector follows one shape: a message naming the
field, what was declared, and what was expected or actual. For the revision
rule specifically, the message names both revisions explicitly, in the form

> `<Document> <number> is at revision <N>; this request is for revision <M>.`

for example:

> Quote Q-0001 is at revision 2; this request is for revision 1.

Nothing is read, written, or changed by a refused call.
