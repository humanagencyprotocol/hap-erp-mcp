/**
 * The gateway binds its bounds (value_max, discount_max, ...) to the
 * DECLARED value/discount_pct/currency on a tool call — it never inspects
 * line items. So the connector's own recompute-and-refuse logic IS the
 * enforcement boundary for the sales profile; a bug here means a bound is
 * decorative. Per doc/engineering.md rule 4 ("test refusals harder than
 * successes"), most of this file is refusal cases, one per property the
 * connector must protect, plus a single happy path proving the whole
 * quote -> send -> order flow (incl. stock reservation) actually works.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { DEMO_COMPANY } from "./fixtures/demo-company.js";
import { list_items, get_item } from "../src/tools/items.js";
import { find_customers, get_customer } from "../src/tools/customers.js";
import { create_quote, update_quote, send_quote, get_quote, list_quotes } from "../src/tools/quotes.js";
import { convert_quote_to_order, get_order } from "../src/tools/orders.js";

let dbPath: string;
let db: Db;

beforeEach(async () => {
  dbPath = join(tmpdir(), `erp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(dbPath, { force: true });
  process.env.DATABASE_URL = dbPath;
  db = await createDb(DEMO_COMPANY);
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { force: true });
  delete process.env.DATABASE_URL;
});

// item-1 WIDGET-100 @ 25.00, stock 500
// cust-1 Nordkap Manufacturing GmbH, EUR, credit_limit 50000, open_balance 12000
// cust-5 Solstice Equipment Co, EUR, credit_limit 5000, open_balance 4800
const ITEM_100 = "item-1"; // 25.00 EUR
const ITEM_200 = "item-2"; // 45.00 EUR
const CUST_ROOMY = "cust-1"; // plenty of credit
const CUST_TIGHT = "cust-5"; // credit_limit 5000, open_balance 4800

describe("seed data", () => {
  it("the demo fixture seeds a deterministic dataset", async () => {
    const items = await list_items(db, {});
    const customers = await find_customers(db, {});
    expect(items.length).toBe(8);
    expect(customers.length).toBe(5);
    const widget = await get_item(db, { id: ITEM_100 });
    expect(widget).toMatchObject({ sku: "WIDGET-100", list_price: 25, stock: 500 });
  });
});

describe("create_quote — declared value must equal the recomputed net total", () => {
  it("refuses when declared value is higher than the recomputed total", async () => {
    // 2 * 25.00 = 50.00, but the caller declares 60
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 2 }],
      discount_pct: 0,
      value: 60,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/value/);
    expect((result as Error).message).toContain("60");
    expect((result as Error).message).toContain("50");
  });

  it("refuses when declared value is lower than the recomputed total (agent under-declaring to dodge value_max)", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 10 }], // 250.00
      discount_pct: 0,
      value: 1,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("1");
    expect((result as Error).message).toContain("250");
  });

  it("accepts a value within the 0.01 rounding tolerance", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 3 }], // 75.00
      discount_pct: 0,
      value: 75.005,
      currency: "EUR",
    });
    expect(quote.net_total).toBe(75);
  });

  it("applies discount_pct in the recomputation", async () => {
    // 4 * 25.00 = 100.00, 10% off = 90.00
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 4 }],
      discount_pct: 10,
      value: 90,
      currency: "EUR",
    });
    expect(quote.net_total).toBe(90);
    expect(quote.discount_pct).toBe(10);
  });
});

describe("create_quote — discount_pct bounds", () => {
  it("refuses a negative discount", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: -5,
      value: 25,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/discount_pct/);
  });

  it("refuses a discount above 100", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 150,
      value: 25,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/discount_pct/);
  });
});

describe("create_quote — currency must match the customer's currency", () => {
  it("refuses a currency that does not match the customer", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY, // EUR customer
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "USD",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/currency/);
    expect((result as Error).message).toContain("USD");
    expect((result as Error).message).toContain("EUR");
  });
});

describe("create_quote — unknown ids and bad quantities are refused", () => {
  it("refuses an unknown customer_id", async () => {
    const result = await create_quote(db, {
      customer_id: "cust-does-not-exist",
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown customer/);
  });

  it("refuses an unknown item_id", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: "item-does-not-exist", qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown item/);
  });

  it("refuses a zero quantity", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 0 }],
      discount_pct: 0,
      value: 0,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/qty/);
  });

  it("refuses a fractional quantity", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1.5 }],
      discount_pct: 0,
      value: 37.5,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/qty/);
  });

  it("refuses an empty lines array", async () => {
    const result = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [],
      discount_pct: 0,
      value: 0,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/lines/);
  });
});

describe("update_quote — state machine: only drafts can be updated", () => {
  it("refuses to update a quote that has already been sent", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 25, discount_pct: 0, currency: "EUR" });

    const result = await update_quote(db, {
      id: quote.id,
      discount_pct: 0,
      value: 25,
      currency: "EUR",
      notes: "trying to edit a sent quote",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/only draft quotes can be updated/);
  });

  it("allows re-pricing a draft when lines change", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }], // 25.00
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });

    const updated = await update_quote(db, {
      id: quote.id,
      lines: [{ item_id: ITEM_200, qty: 2 }], // 90.00
      discount_pct: 0,
      value: 90,
      currency: "EUR",
    });
    expect(updated.net_total).toBe(90);
  });
});

describe("send_quote — state machine and frozen discount", () => {
  it("refuses to send an already-sent quote", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 25, discount_pct: 0, currency: "EUR" });

    const result = await send_quote(db, { id: quote.id, revision: quote.revision, value: 25, discount_pct: 0, currency: "EUR" }).catch(
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/only draft quotes can be sent/);
  });

  it("refuses a discount_pct that differs from the quote's stored discount", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 4 }], // 100.00
      discount_pct: 10, // 90.00
      value: 90,
      currency: "EUR",
    });

    // Caller tries to sneak in a bigger discount at send time than what was
    // quoted — this must not silently take effect.
    const result = await send_quote(db, { id: quote.id, revision: quote.revision, value: 80, discount_pct: 20, currency: "EUR" }).catch(
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/discount_pct/);
  });

  it("refuses a currency that differs from the quote's stored currency", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });

    const result = await send_quote(db, { id: quote.id, revision: quote.revision, value: 25, discount_pct: 0, currency: "USD" }).catch(
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/currency/);
  });
});

describe("convert_quote_to_order — state machine", () => {
  it("refuses to convert a quote still in draft (must be sent first)", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });

    const result = await convert_quote_to_order(db, {
      id: quote.id,
      revision: quote.revision,
      value: 25,
      discount_pct: 0,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/only sent quotes can be converted/);
  });

  it("refuses double conversion of the same quote", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 25, discount_pct: 0, currency: "EUR" });
    await convert_quote_to_order(db, { id: quote.id, revision: quote.revision, value: 25, discount_pct: 0, currency: "EUR" });

    const result = await convert_quote_to_order(db, {
      id: quote.id,
      revision: quote.revision,
      value: 25,
      discount_pct: 0,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/only sent quotes can be converted/);
  });
});

describe("convert_quote_to_order — credit limit", () => {
  it("refuses when open_balance + net_total would exceed the customer's credit limit", async () => {
    // cust-5: credit_limit 5000, open_balance 4800 — 300 more tips it over.
    const quote = await create_quote(db, {
      customer_id: CUST_TIGHT,
      lines: [{ item_id: ITEM_200, qty: 10 }], // 450.00 (< available credit)
      discount_pct: 0,
      value: 450,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 450, discount_pct: 0, currency: "EUR" });

    const result = await convert_quote_to_order(db, {
      id: quote.id,
      revision: quote.revision,
      value: 450,
      discount_pct: 0,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/credit limit/);
    expect((result as Error).message).toContain("4800");
    expect((result as Error).message).toContain("5000");
  });

  it("allows conversion that stays within the credit limit", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_TIGHT,
      lines: [{ item_id: ITEM_100, qty: 4 }], // 100.00, well within 200 available
      discount_pct: 0,
      value: 100,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 100, discount_pct: 0, currency: "EUR" });

    const order = await convert_quote_to_order(db, {
      id: quote.id,
      revision: quote.revision,
      value: 100,
      discount_pct: 0,
      currency: "EUR",
    });
    expect(order.status).toBe("confirmed");
  });

  it("does not reserve stock when the credit check refuses the conversion", async () => {
    const before = await get_item(db, { id: ITEM_200 });
    const quote = await create_quote(db, {
      customer_id: CUST_TIGHT,
      lines: [{ item_id: ITEM_200, qty: 10 }], // exceeds credit limit
      discount_pct: 0,
      value: 450,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 450, discount_pct: 0, currency: "EUR" });
    await convert_quote_to_order(db, { id: quote.id, revision: quote.revision, value: 450, discount_pct: 0, currency: "EUR" }).catch(
      (e) => e
    );

    const after = await get_item(db, { id: ITEM_200 });
    expect(after.stock).toBe(before.stock);
  });
});

describe("convert_quote_to_order — stock", () => {
  it("refuses when a line exceeds available stock", async () => {
    // item-4 GEAR-B2 has stock 60
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: "item-4", qty: 61 }],
      discount_pct: 0,
      value: 150 * 61,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 150 * 61, discount_pct: 0, currency: "EUR" });

    const result = await convert_quote_to_order(db, {
      id: quote.id,
      revision: quote.revision,
      value: 150 * 61,
      discount_pct: 0,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/insufficient stock/);
    expect((result as Error).message).toContain("GEAR-B2");
  });

  it("refuses the whole order when only one of several lines lacks stock — no partial reservation", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [
        { item_id: ITEM_100, qty: 5 }, // plenty of stock
        { item_id: "item-4", qty: 61 }, // exceeds stock (60)
      ],
      discount_pct: 0,
      value: 25 * 5 + 150 * 61,
      currency: "EUR",
    });
    await send_quote(db, { id: quote.id, revision: quote.revision, value: 25 * 5 + 150 * 61, discount_pct: 0, currency: "EUR" });

    const widgetBefore = await get_item(db, { id: ITEM_100 });
    const result = await convert_quote_to_order(db, {
      id: quote.id,
      revision: quote.revision,
      value: 25 * 5 + 150 * 61,
      discount_pct: 0,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);

    const widgetAfter = await get_item(db, { id: ITEM_100 });
    expect(widgetAfter.stock).toBe(widgetBefore.stock); // the in-stock line was NOT reserved either
  });
});

describe("happy path — quote -> send -> convert reserves stock", () => {
  it("carries a document through its full lifecycle", async () => {
    const widgetBefore = await get_item(db, { id: ITEM_100 });

    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 5 }], // 125.00
      discount_pct: 0,
      value: 125,
      currency: "EUR",
      notes: "Q3 restock",
    });
    expect(quote.status).toBe("draft");
    expect(quote.net_total).toBe(125);

    const sent = await send_quote(db, { id: quote.id, revision: quote.revision, value: 125, discount_pct: 0, currency: "EUR" });
    expect(sent.status).toBe("sent");
    expect(sent.sent_at).toBeTruthy();

    const order = await convert_quote_to_order(db, {
      id: quote.id,
      revision: quote.revision,
      value: 125,
      discount_pct: 0,
      currency: "EUR",
      requested_delivery: "2026-11-01",
    });
    expect(order.status).toBe("confirmed");
    expect(order.net_total).toBe(125);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({ item_id: ITEM_100, qty: 5 });

    const widgetAfter = await get_item(db, { id: ITEM_100 });
    expect(widgetAfter.stock).toBe(widgetBefore.stock - 5);

    const quoteAfter = await get_quote(db, { id: quote.id });
    expect(quoteAfter.status).toBe("converted");

    const orderBack = await get_order(db, { id: order.id });
    expect(orderBack.number).toMatch(/^O-\d{4}$/);
  });
});

describe("quote revisions — an approval binds one exact version", () => {
  it("create_quote always produces revision 1", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    expect(quote.revision).toBe(1);
  });

  it("update_quote always produces the next revision", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }], // 25.00
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    expect(quote.revision).toBe(1);

    const updated = await update_quote(db, {
      id: quote.id,
      lines: [{ item_id: ITEM_200, qty: 1 }], // 45.00 — a different line item entirely
      discount_pct: 0,
      value: 45,
      currency: "EUR",
    });
    expect(updated.revision).toBe(2);
    expect(updated.net_total).toBe(45);

    const updatedAgain = await update_quote(db, {
      id: quote.id,
      discount_pct: 0,
      value: 45,
      currency: "EUR",
      notes: "a third version, lines unchanged",
    });
    expect(updatedAgain.revision).toBe(3);
  });

  it("update_quote bumps the revision even when only notes change (lines and discount untouched)", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });

    const updated = await update_quote(db, {
      id: quote.id,
      discount_pct: 0,
      value: 25,
      currency: "EUR",
      notes: "call before delivery",
    });
    expect(updated.revision).toBe(2);
    expect(updated.lines).toHaveLength(1); // lines carried over unchanged
  });

  it("send_quote refuses a stale revision, naming both revisions — nothing changes", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }], // 25.00
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    expect(quote.revision).toBe(1);

    await update_quote(db, {
      id: quote.id,
      lines: [{ item_id: ITEM_200, qty: 1 }], // 45.00, different item than revision 1
      discount_pct: 0,
      value: 45,
      currency: "EUR",
    });

    const result = await send_quote(db, {
      id: quote.id,
      value: 25,
      discount_pct: 0,
      currency: "EUR",
      revision: 1, // stale — the quote is now at revision 2
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/revision/);
    expect((result as Error).message).toContain(`${quote.number} is at revision 2`);
    expect((result as Error).message).toContain("this request is for revision 1");

    const stillDraft = await get_quote(db, { id: quote.id });
    expect(stillDraft.status).toBe("draft");
    expect(stillDraft.sent_at).toBeNull();
  });

  it("send_quote succeeds once the caller names the quote's current revision", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    const updated = await update_quote(db, {
      id: quote.id,
      lines: [{ item_id: ITEM_200, qty: 1 }], // 45.00
      discount_pct: 0,
      value: 45,
      currency: "EUR",
    });
    expect(updated.revision).toBe(2);

    const sent = await send_quote(db, { id: quote.id, value: 45, discount_pct: 0, currency: "EUR", revision: 2 });
    expect(sent.status).toBe("sent");
    expect(sent.revision).toBe(2);
  });

  it("the race: create (rev 1) -> update (rev 2, same total, different lines) -> send(revision:1) refused, send(revision:2) works", async () => {
    // 1 x WIDGET-100 (25.00) vs 1 x WIDGET-200 Pro (45.00) is NOT the same
    // total, so pick a discount that lands revision 2 on the same net total
    // as revision 1 — the scenario the brief names explicitly: same total,
    // different items, so a value-only check could not have caught it.
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }], // 25.00, 0% discount
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    expect(quote.revision).toBe(1);

    const updated = await update_quote(db, {
      id: quote.id,
      lines: [{ item_id: ITEM_200, qty: 1 }], // 45.00 gross
      discount_pct: 44.444444444444, // 45 * (1 - 0.44444444444) = 25.00
      value: 25,
      currency: "EUR",
    });
    expect(updated.revision).toBe(2);
    expect(updated.net_total).toBe(25); // same total as revision 1 — a value-only guard would miss this

    const refused = await send_quote(db, {
      id: quote.id, value: 25, discount_pct: 44.444444444444, currency: "EUR", revision: 1,
    }).catch((e) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/revision/);

    const afterRefusal = await get_quote(db, { id: quote.id });
    expect(afterRefusal.status).toBe("draft"); // still draft — nothing was sent
    expect(afterRefusal.revision).toBe(2);

    const sent = await send_quote(db, {
      id: quote.id, value: 25, discount_pct: 44.444444444444, currency: "EUR", revision: 2,
    });
    expect(sent.status).toBe("sent");
  });

  it("convert_quote_to_order refuses a stale revision the same way send_quote does", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    const sent = await send_quote(db, { id: quote.id, value: 25, discount_pct: 0, currency: "EUR", revision: quote.revision });
    expect(sent.revision).toBe(1);

    // Pass a stale revision at conversion time — the quote's revision is frozen
    // at 1 once sent (no update_quote reaches a sent quote), so this exercises
    // the same refuse() path with a declared revision that never existed as current.
    const result = await convert_quote_to_order(db, {
      id: quote.id, value: 25, discount_pct: 0, currency: "EUR", revision: 99,
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/revision/);
    expect((result as Error).message).toContain("this request is for revision 99");

    const stillSent = await get_quote(db, { id: quote.id });
    expect(stillSent.status).toBe("sent"); // not converted
  });

  it("get_quote with a revision argument returns that exact historical version, not the current one", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }], // 25.00
      discount_pct: 0,
      value: 25,
      currency: "EUR",
      notes: "first draft",
    });
    await update_quote(db, {
      id: quote.id,
      lines: [{ item_id: ITEM_200, qty: 1 }], // 45.00
      discount_pct: 0,
      value: 45,
      currency: "EUR",
      notes: "revised draft",
    });

    const rev1 = await get_quote(db, { id: quote.id, revision: 1 });
    expect(rev1.revision).toBe(1);
    expect(rev1.net_total).toBe(25);
    expect(rev1.notes).toBe("first draft");
    expect(rev1.lines).toEqual([expect.objectContaining({ item_id: ITEM_100, qty: 1 })]);
    expect(rev1.status).toBe("draft"); // status is the document's, not the revision's

    const current = await get_quote(db, { id: quote.id });
    expect(current.revision).toBe(2);
    expect(current.net_total).toBe(45);

    const explicitCurrent = await get_quote(db, { id: quote.id, revision: 2 });
    expect(explicitCurrent.net_total).toBe(45);
    expect(explicitCurrent.notes).toBe("revised draft");
  });

  it("get_quote refuses an unknown revision number", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    const result = await get_quote(db, { id: quote.id, revision: 7 }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown revision/);
  });

  it("list_quotes and create_quote/update_quote results all carry the revision", async () => {
    const quote = await create_quote(db, {
      customer_id: CUST_ROOMY,
      lines: [{ item_id: ITEM_100, qty: 1 }],
      discount_pct: 0,
      value: 25,
      currency: "EUR",
    });
    expect(quote.revision).toBe(1);
    const updated = await update_quote(db, {
      id: quote.id, discount_pct: 0, value: 25, currency: "EUR", notes: "x",
    });
    expect(updated.revision).toBe(2);

    const listed = await list_quotes(db, { customer_id: CUST_ROOMY });
    expect(listed.find((q) => q.id === quote.id)?.revision).toBe(2);
  });
});

describe("reads", () => {
  it("get_customer reports available_credit derived from credit_limit and open_balance", async () => {
    const customer = await get_customer(db, { id: CUST_TIGHT });
    expect(customer.credit_limit).toBe(5000);
    expect(customer.open_balance).toBe(4800);
    expect(customer.available_credit).toBe(200);
  });

  it("get_item refuses an unknown id instead of returning undefined", async () => {
    const result = await get_item(db, { id: "does-not-exist" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown item/);
  });
});
