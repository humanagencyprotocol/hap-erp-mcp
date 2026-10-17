/**
 * Invoicing (Andreas, 2026-10-17 — German/Austrian invoicing law): an issued
 * invoice is never changed or deleted; a cancellation or correction is a
 * credit note with its own number. Per doc/engineering.md rule 4 ("test
 * refusals harder than successes"), most of this file is refusal cases, one
 * per property create_invoice/create_credit_note must protect, plus the
 * happy paths (order-derived invoice, explicit-line invoice, partial-then-
 * full credit, numbering, rounding).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { DEMO_COMPANY } from "./fixtures/demo-company.js";
import { create_quote, send_quote } from "../src/tools/quotes.js";
import { convert_quote_to_order } from "../src/tools/orders.js";
import {
  create_invoice,
  create_credit_note,
  get_invoice,
  list_invoices,
  get_credit_note,
  list_credit_notes,
} from "../src/tools/invoices.js";

let dbPath: string;
let db: Db;

beforeEach(async () => {
  dbPath = join(tmpdir(), `erp-inv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(dbPath, { force: true });
  process.env.DATABASE_URL = dbPath;
  db = await createDb(DEMO_COMPANY);
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { force: true });
  delete process.env.DATABASE_URL;
});

// item-1 WIDGET-100 @ 25.00, item-2 WIDGET-200 @ 45.00, item-4 GEAR-B2 @ 150.00
// cust-1 Nordkap Manufacturing GmbH, EUR, plenty of credit
// cust-2 Alpine Components AG, EUR, plenty of credit
const ITEM_100 = "item-1";
const ITEM_200 = "item-2";
const CUST_A = "cust-1";
const CUST_B = "cust-2";
const YEAR = new Date().getFullYear();

/** Quote -> send -> order for cust-1, qty of item-1 — returns the confirmed order. */
async function orderFor(customerId: string, qty: number, itemId = ITEM_100, unitPrice = 25) {
  const value = Math.round(qty * unitPrice * 100) / 100;
  const quote = await create_quote(db, {
    customer_id: customerId, lines: [{ item_id: itemId, qty }], discount_pct: 0, value, currency: "EUR",
  });
  await send_quote(db, { id: quote.id, revision: quote.revision, value, discount_pct: 0, currency: "EUR" });
  return convert_quote_to_order(db, { id: quote.id, revision: quote.revision, value, discount_pct: 0, currency: "EUR" });
}

describe("create_invoice — from an order", () => {
  it("derives lines from the order, applies the default VAT rate, and issues immediately", async () => {
    const order = await orderFor(CUST_A, 2); // 2 x 25.00 = 50.00

    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 50, currency: "EUR" });

    expect(invoice.status).toBe("issued");
    expect(invoice.number).toMatch(new RegExp(`^INV-${YEAR}-0001$`));
    expect(invoice.net_total).toBe(50);
    expect(invoice.vat_total).toBe(10); // 20% Austrian default
    expect(invoice.gross_total).toBe(60);
    expect(invoice.credited_total).toBe(0);
    expect(invoice.order_id).toBe(order.id);
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]).toMatchObject({ item_id: ITEM_100, qty: 2, unit_price: 25, vat_rate: 20, line_net: 50, line_vat: 10 });

    const issued = new Date(invoice.issued_at).getTime();
    const due = new Date(invoice.due_date).getTime();
    expect(due - issued).toBe(14 * 24 * 60 * 60 * 1000); // default payment_term_days
  });

  it("honors an explicit payment_term_days", async () => {
    const order = await orderFor(CUST_A, 1); // 25.00
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR", payment_term_days: 30 });
    const issued = new Date(invoice.issued_at).getTime();
    const due = new Date(invoice.due_date).getTime();
    expect(due - issued).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("numbers invoices INV-<year>-<4-digit sequence>, incrementing per call", async () => {
    const order1 = await orderFor(CUST_A, 1);
    const order2 = await orderFor(CUST_A, 1);
    const inv1 = await create_invoice(db, { customer_id: CUST_A, order_id: order1.id, net_total: 25, currency: "EUR" });
    const inv2 = await create_invoice(db, { customer_id: CUST_A, order_id: order2.id, net_total: 25, currency: "EUR" });
    expect(inv1.number).toBe(`INV-${YEAR}-0001`);
    expect(inv2.number).toBe(`INV-${YEAR}-0002`);
  });
});

describe("create_invoice — from explicit lines", () => {
  it("accepts explicit lines with their own vat_rate, independent of the catalog", async () => {
    const invoice = await create_invoice(db, {
      customer_id: CUST_A,
      lines: [{ description: "Consulting — October", qty: 3, unit_price: 100, vat_rate: 20 }],
      net_total: 300,
      currency: "EUR",
    });
    expect(invoice.net_total).toBe(300);
    expect(invoice.vat_total).toBe(60);
    expect(invoice.gross_total).toBe(360);
    expect(invoice.order_id).toBeNull();
    expect(invoice.lines[0]).toMatchObject({ description: "Consulting — October", vat_rate: 20 });
  });

  it("sums multiple lines with different VAT rates correctly (rounding in cents)", async () => {
    // 3 x 10.10 = 30.30 net @ 20% VAT = 6.06; 1 x 7.77 = 7.77 net @ 10% VAT = 0.777 -> 0.78
    const invoice = await create_invoice(db, {
      customer_id: CUST_A,
      lines: [
        { description: "A", qty: 3, unit_price: 10.1, vat_rate: 20 },
        { description: "B", qty: 1, unit_price: 7.77, vat_rate: 10 },
      ],
      net_total: 38.07,
      currency: "EUR",
    });
    expect(invoice.net_total).toBe(38.07);
    expect(invoice.vat_total).toBe(6.84); // 6.06 + 0.78
    expect(invoice.gross_total).toBe(44.91);
  });

  it("accepts a net_total within the 0.005 tolerance", async () => {
    const invoice = await create_invoice(db, {
      customer_id: CUST_A,
      lines: [{ description: "X", qty: 1, unit_price: 10, vat_rate: 20 }],
      net_total: 10.004,
      currency: "EUR",
    });
    expect(invoice.net_total).toBe(10);
  });

  it("refuses a net_total that differs by more than 0.005", async () => {
    const result = await create_invoice(db, {
      customer_id: CUST_A,
      lines: [{ description: "X", qty: 1, unit_price: 10, vat_rate: 20 }],
      net_total: 10.01,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/net_total/);
    expect((result as Error).message).toContain("10.01");
    expect((result as Error).message).toContain("10");
  });
});

describe("create_invoice — refusals", () => {
  it("refuses an unknown customer_id", async () => {
    const result = await create_invoice(db, {
      customer_id: "cust-does-not-exist",
      lines: [{ description: "X", qty: 1, unit_price: 10, vat_rate: 20 }],
      net_total: 10,
      currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown customer/);
  });

  it("refuses an unknown order_id", async () => {
    const result = await create_invoice(db, {
      customer_id: CUST_A, order_id: "order-does-not-exist", net_total: 0, currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown order/);
  });

  it("refuses when the order belongs to another customer", async () => {
    const order = await orderFor(CUST_A, 1); // belongs to cust-1
    const result = await create_invoice(db, {
      customer_id: CUST_B, order_id: order.id, net_total: 25, currency: "EUR",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/belongs to customer/);
  });

  it("refuses when neither order_id nor lines is given", async () => {
    const result = await create_invoice(db, { customer_id: CUST_A, net_total: 0, currency: "EUR" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/requires either order_id or a non-empty lines array/);
  });

  it("refuses a currency that differs from the order's currency", async () => {
    const order = await orderFor(CUST_A, 1); // EUR
    const result = await create_invoice(db, {
      customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "USD",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/currency/);
    expect((result as Error).message).toContain("USD");
    expect((result as Error).message).toContain("EUR");
  });

  it("refuses a currency that differs from the customer's currency when invoicing from explicit lines", async () => {
    const result = await create_invoice(db, {
      customer_id: CUST_A, // EUR customer
      lines: [{ description: "X", qty: 1, unit_price: 10, vat_rate: 20 }],
      net_total: 10,
      currency: "USD",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/currency/);
  });

  it("refuses a second invoice on an order that already has one issued and not credited", async () => {
    const order = await orderFor(CUST_A, 1);
    await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });

    const result = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/already has invoice/);
    expect((result as Error).message).toMatch(/issued and not credited/);
  });

  it("allows a new invoice on an order once the prior one is fully credited", async () => {
    const order = await orderFor(CUST_A, 1); // 25.00
    const first = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });
    await create_credit_note(db, { invoice_id: first.id, credit_total: 25, currency: "EUR", reason: "cancelled" });

    const second = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });
    expect(second.status).toBe("issued");
    expect(second.number).not.toBe(first.number);
  });
});

describe("create_credit_note — partial then full credit", () => {
  it("moves issued -> partially_credited -> credited, naming net totals correctly at each step", async () => {
    const order = await orderFor(CUST_A, 4, ITEM_200, 45); // 4 x 45.00 = 180.00
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 180, currency: "EUR" });
    expect(invoice.status).toBe("issued");

    // Partial credit via explicit lines: credit 2 of the 4 units.
    const partial = await create_credit_note(db, {
      invoice_id: invoice.id,
      credit_total: 90,
      currency: "EUR",
      reason: "2 units returned",
      lines: [{ item_id: ITEM_200, description: "Widget 200 Pro", qty: 2, unit_price: 45, vat_rate: 20 }],
    });
    expect(partial.number).toMatch(new RegExp(`^CN-${YEAR}-0001$`));
    expect(partial.net_total).toBe(90);
    expect(partial.vat_total).toBe(18);
    expect(partial.invoice_id).toBe(invoice.id);
    expect(partial.invoice_number).toBe(invoice.number);

    const afterPartial = await get_invoice(db, { id: invoice.id });
    expect(afterPartial.status).toBe("partially_credited");
    expect(afterPartial.credited_total).toBe(90);

    // Full credit of the remainder — lines omitted.
    const rest = await create_credit_note(db, {
      invoice_id: invoice.id, credit_total: 90, currency: "EUR", reason: "remaining units returned too",
    });
    expect(rest.number).toMatch(new RegExp(`^CN-${YEAR}-0002$`));
    expect(rest.net_total).toBe(90);
    expect(rest.vat_total).toBe(18); // same effective VAT rate as the invoice (20%)

    const afterFull = await get_invoice(db, { id: invoice.id });
    expect(afterFull.status).toBe("credited");
    expect(afterFull.credited_total).toBe(180);
  });
});

describe("create_credit_note — refusals", () => {
  it("refuses an unknown invoice id/number", async () => {
    const result = await create_credit_note(db, {
      invoice_id: "does-not-exist", credit_total: 10, currency: "EUR", reason: "x",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown invoice/);
  });

  it("refuses a currency that differs from the invoice's currency", async () => {
    const order = await orderFor(CUST_A, 1);
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });
    const result = await create_credit_note(db, {
      invoice_id: invoice.id, credit_total: 25, currency: "USD", reason: "x",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/currency/);
  });

  it("refuses a credit_total that differs from the recomputed lines total by more than 0.005", async () => {
    const order = await orderFor(CUST_A, 1); // 25.00
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });
    const result = await create_credit_note(db, {
      invoice_id: invoice.id, credit_total: 20, currency: "EUR", reason: "x",
      lines: [{ item_id: ITEM_100, description: "Widget 100", qty: 1, unit_price: 25, vat_rate: 20 }],
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/credit_total/);
    expect((result as Error).message).toContain("20");
    expect((result as Error).message).toContain("25");
  });

  it("refuses a credit that would exceed the invoice's remaining (uncredited) net total", async () => {
    const order = await orderFor(CUST_A, 1); // 25.00
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });
    const result = await create_credit_note(db, {
      invoice_id: invoice.id, credit_total: 30, currency: "EUR", reason: "x",
      lines: [{ item_id: ITEM_100, description: "Widget 100", qty: 1, unit_price: 30, vat_rate: 20 }],
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/exceed/);

    // the invoice is untouched by the refused attempt
    const after = await get_invoice(db, { id: invoice.id });
    expect(after.status).toBe("issued");
    expect(after.credited_total).toBe(0);
  });

  it("refuses a second partial credit that would exceed what remains after the first", async () => {
    const order = await orderFor(CUST_A, 4, ITEM_200, 45); // 180.00
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 180, currency: "EUR" });
    await create_credit_note(db, {
      invoice_id: invoice.id, credit_total: 90, currency: "EUR", reason: "half",
      lines: [{ item_id: ITEM_200, description: "x", qty: 2, unit_price: 45, vat_rate: 20 }],
    });
    // Only 90.00 remains — asking for another 100.00 must be refused.
    const result = await create_credit_note(db, {
      invoice_id: invoice.id, credit_total: 100, currency: "EUR", reason: "too much",
      lines: [{ item_id: ITEM_200, description: "x", qty: 2, unit_price: 50, vat_rate: 20 }],
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/exceed/);
  });

  it("refuses a missing reason", async () => {
    const order = await orderFor(CUST_A, 1);
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });
    const result = await create_credit_note(db, { invoice_id: invoice.id, credit_total: 25, currency: "EUR" } as any).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/reason/);
  });
});

describe("reads", () => {
  it("get_invoice accepts either the id or the invoice number", async () => {
    const order = await orderFor(CUST_A, 1);
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });

    const byId = await get_invoice(db, { id: invoice.id });
    expect(byId.id).toBe(invoice.id);
    const byNumber = await get_invoice(db, { id: invoice.number });
    expect(byNumber.id).toBe(invoice.id);
  });

  it("get_invoice refuses an unknown id/number", async () => {
    const result = await get_invoice(db, { id: "nope" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Unknown invoice/);
  });

  it("list_invoices filters by customer and status", async () => {
    const orderA = await orderFor(CUST_A, 1);
    const orderB = await orderFor(CUST_B, 1);
    const invA = await create_invoice(db, { customer_id: CUST_A, order_id: orderA.id, net_total: 25, currency: "EUR" });
    await create_invoice(db, { customer_id: CUST_B, order_id: orderB.id, net_total: 25, currency: "EUR" });
    await create_credit_note(db, { invoice_id: invA.id, credit_total: 25, currency: "EUR", reason: "x" });

    const forA = await list_invoices(db, { customer_id: CUST_A });
    expect(forA).toHaveLength(1);
    expect(forA[0].id).toBe(invA.id);

    const credited = await list_invoices(db, { status: "credited" });
    expect(credited).toHaveLength(1);
    expect(credited[0].id).toBe(invA.id);
  });

  it("get_credit_note and list_credit_notes filter by invoice_id and customer_id", async () => {
    const order = await orderFor(CUST_A, 1);
    const invoice = await create_invoice(db, { customer_id: CUST_A, order_id: order.id, net_total: 25, currency: "EUR" });
    const cn = await create_credit_note(db, { invoice_id: invoice.id, credit_total: 25, currency: "EUR", reason: "x" });

    const fetched = await get_credit_note(db, { id: cn.id });
    expect(fetched.number).toBe(cn.number);
    expect(fetched.invoice_number).toBe(invoice.number);

    const byInvoice = await list_credit_notes(db, { invoice_id: invoice.id });
    expect(byInvoice).toHaveLength(1);
    const byCustomer = await list_credit_notes(db, { customer_id: CUST_A });
    expect(byCustomer).toHaveLength(1);
    const byOtherCustomer = await list_credit_notes(db, { customer_id: CUST_B });
    expect(byOtherCustomer).toHaveLength(0);
  });
});
