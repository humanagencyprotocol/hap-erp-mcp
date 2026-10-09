# ERP connector contract

This describes the contract this connector keeps with any caller — the tools,
their arguments, and the refusal rules — independent of what runs behind it
(a simulated database today; a real ERP system behind a live adapter later).
It is vendor-neutral by design: nothing here names a product, a specific
governance layer, or a gating mechanism. A caller only needs this document and
the tool list the server advertises.

## Documents and their life cycle

A **quote** moves through a fixed set of statuses:

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
- **Old revisions are kept.** Nothing a caller can do erases an earlier
  version of a quote's content (see below).

An **order** is created once, by converting a sent quote. It has no separate
revision history: it is a snapshot of the quote at the moment of conversion.

## The revision rule

Every quote carries an integer **revision**, starting at 1.

- **Any change to a quote's content creates the next revision.** Creating a
  quote is revision 1. Every subsequent `update_quote` call that succeeds
  produces revision 2, then 3, and so on — regardless of whether the change
  looks material (different line items at the same total still produce a new
  revision; the revision tracks the document, not just its total).
- **A revision, once created, never changes.** Its content — line items,
  discount, currency, validity date, notes — is frozen the moment the next
  revision exists. A caller can always retrieve it by number (see
  `get_quote` below).
- **Actions that act on a quote's content name the revision they act on.**
  `send_quote` and `convert_quote_to_order` both require a `revision`
  argument. The call is refused if the quote is no longer at that revision —
  this is what makes a request to "send this quote" bind to one exact
  version of its content, even if the quote changed between the moment the
  request was made and the moment it was acted on.
- A revision mismatch is refused the same way every other declared-value
  mismatch is refused in this connector: naming the field (`revision`), the
  revision the caller declared, and the quote's actual current revision.
  Nothing about the quote changes when this refusal happens.

This follows ordinary optimistic-locking practice (compare-and-refuse on a
version number) and is not unusual among ERP systems: a release on a sales
document is tied to the document version it was given at the time, and a
later edit resets it.

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
rule specifically, the message names both revisions explicitly, for example:

> Quote Q-0001 is at revision 2; this request is for revision 1.

Nothing is read, written, or changed by a refused call.
