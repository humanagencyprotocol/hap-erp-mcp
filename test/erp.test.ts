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
import { list_items, get_item } from "../src/tools/items.js";
import { find_customers, get_customer } from "../src/tools/customers.js";
import { create_quote, update_quote, send_quote, get_quote } from "../src/tools/quotes.js";
import { convert_quote_to_order, get_order } from "../src/tools/orders.js";

let dbPath: string;
let db: Db;

beforeEach(async () => {
  dbPath = join(tmpdir(), `erp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(dbPath, { force: true });
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
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
  it("seeds a deterministic demo dataset on an empty DB", async () => {
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
    await send_quote(db, { id: quote.id, value: 25, discount_pct: 0, currency: "EUR" });

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
    await send_quote(db, { id: quote.id, value: 25, discount_pct: 0, currency: "EUR" });

    const result = await send_quote(db, { id: quote.id, value: 25, discount_pct: 0, currency: "EUR" }).catch(
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
    const result = await send_quote(db, { id: quote.id, value: 80, discount_pct: 20, currency: "EUR" }).catch(
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

    const result = await send_quote(db, { id: quote.id, value: 25, discount_pct: 0, currency: "USD" }).catch(
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
    await send_quote(db, { id: quote.id, value: 25, discount_pct: 0, currency: "EUR" });
    await convert_quote_to_order(db, { id: quote.id, value: 25, discount_pct: 0, currency: "EUR" });

    const result = await convert_quote_to_order(db, {
      id: quote.id,
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
    await send_quote(db, { id: quote.id, value: 450, discount_pct: 0, currency: "EUR" });

    const result = await convert_quote_to_order(db, {
      id: quote.id,
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
    await send_quote(db, { id: quote.id, value: 100, discount_pct: 0, currency: "EUR" });

    const order = await convert_quote_to_order(db, {
      id: quote.id,
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
    await send_quote(db, { id: quote.id, value: 450, discount_pct: 0, currency: "EUR" });
    await convert_quote_to_order(db, { id: quote.id, value: 450, discount_pct: 0, currency: "EUR" }).catch(
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
    await send_quote(db, { id: quote.id, value: 150 * 61, discount_pct: 0, currency: "EUR" });

    const result = await convert_quote_to_order(db, {
      id: quote.id,
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
    await send_quote(db, { id: quote.id, value: 25 * 5 + 150 * 61, discount_pct: 0, currency: "EUR" });

    const widgetBefore = await get_item(db, { id: ITEM_100 });
    const result = await convert_quote_to_order(db, {
      id: quote.id,
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

    const sent = await send_quote(db, { id: quote.id, value: 125, discount_pct: 0, currency: "EUR" });
    expect(sent.status).toBe("sent");
    expect(sent.sent_at).toBeTruthy();

    const order = await convert_quote_to_order(db, {
      id: quote.id,
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
