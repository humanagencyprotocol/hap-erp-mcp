/**
 * Part C — catalogue in ERP Local (docs/local-production-contract.md §5, §8):
 * item writes and the revision rule (R11), the price as its own tool, and the
 * catalogue link on document lines (list price + item revision stored at
 * issue, deviation not refused, inactive items refused on new lines only).
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import { create_invoice, preview_invoice, create_credit_note, get_invoice, get_document } from "../../src/live/local/tools/invoices.js";
import { create_item, update_item, update_item_price, get_item, list_items } from "../../src/live/local/tools/items.js";
import { validateLocalLines, resolveLocalLines } from "../../src/live/local/lines.js";
import { createLocalDb } from "../../src/live/local/db.js";
import { freshLocalCtx, cleanupDataDir, seedAtCustomer, INVOICE_ARGS_BASE } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;

afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const CONSULTING = { name: "Beratung", kind: "service", unit: "Std.", list_price: 120, vat_rate: 20, sku: "B-01" };

async function revisionRows(id: string) {
  return db.all<{ revision: number; content: string; ticket_id: string | null }>(
    "SELECT revision, content, ticket_id FROM local_master_revisions WHERE entity = 'item' AND entity_id = ? ORDER BY revision",
    [id]
  );
}

describe("create_item", () => {
  it("creates revision 1 with the simulator's field names and a revision row carrying the ticket", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-create"));
    const item = await create_item(db, { ...CONSULTING, description: "Senior", ticket_id: "t-1" });
    expect(item).toMatchObject({ sku: "B-01", name: "Beratung", description: "Senior", kind: "service", unit: "Std.",
      list_price: 120, currency: "EUR", vat_rate: 20, active: true, revision: 1, stock: null });
    const revs = await revisionRows(item.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ revision: 1, ticket_id: "t-1" });
    expect(JSON.parse(revs[0].content)).toMatchObject({ list_price: 120, vat_rate: 20, active: true });
  });

  it("refuses bad fields, writing nothing", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-create-bad"));
    await expect(create_item(db, { ...CONSULTING, list_price: -1 })).rejects.toThrow(/list_price must be a finite number >= 0/);
    await expect(create_item(db, { ...CONSULTING, list_price: Infinity })).rejects.toThrow(/list_price/);
    await expect(create_item(db, { ...CONSULTING, vat_rate: 101 })).rejects.toThrow(/vat_rate must be a number between 0 and 100/);
    await expect(create_item(db, { ...CONSULTING, kind: "bundle" })).rejects.toThrow(/kind must be one of service, product/);
    await expect(create_item(db, { ...CONSULTING, name: " " })).rejects.toThrow(/name must be a non-empty string/);
    expect(await db.all("SELECT * FROM local_items")).toEqual([]);
    expect(await db.all("SELECT * FROM local_master_revisions WHERE entity = 'item'")).toEqual([]);
  });

  it("refuses a duplicate sku naming the existing item", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-sku-dup"));
    const first = await create_item(db, CONSULTING);
    await expect(create_item(db, { ...CONSULTING, name: "Other" })).rejects.toThrow(
      new RegExp(`item ${first.id} already has item number B-01. Nothing was saved.`)
    );
    expect(await db.all("SELECT * FROM local_items")).toHaveLength(1);
    // no sku → no uniqueness constraint
    await create_item(db, { ...CONSULTING, sku: undefined });
    await create_item(db, { ...CONSULTING, sku: undefined });
  });
});

describe("update_item (not price / VAT rate)", () => {
  it("moves to the next revision; the old revision stays readable", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-update"));
    const item = await create_item(db, CONSULTING);
    const updated = await update_item(db, { id: item.id, revision: 1, name: "Beratung Senior", ticket_id: "t-2" });
    expect(updated).toMatchObject({ name: "Beratung Senior", revision: 2, list_price: 120 });
    expect((await get_item(db, { id: item.id, revision: 1 })).name).toBe("Beratung");
    expect((await get_item(db, { id: item.id })).name).toBe("Beratung Senior");
    expect((await revisionRows(item.id)).map((r) => [r.revision, r.ticket_id])).toEqual([[1, null], [2, "t-2"]]);
  });

  it("refuses a stale revision naming both, changing nothing", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-stale"));
    const item = await create_item(db, CONSULTING);
    await update_item(db, { id: item.id, revision: 1, unit: "h" });
    await expect(update_item(db, { id: item.id, revision: 1, name: "X" })).rejects.toThrow(
      `Refused: Item ${item.id} is at revision 2; this request is for revision 1. Nothing was saved.`
    );
    await expect(update_item_price(db, { id: item.id, revision: 1, list_price: 99, vat_rate: 20 })).rejects.toThrow(
      /is at revision 2; this request is for revision 1/
    );
    expect(await get_item(db, { id: item.id })).toMatchObject({ name: "Beratung", list_price: 120, revision: 2 });
  });

  it("refuses list_price / vat_rate — price is its own decision", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-update-price"));
    const item = await create_item(db, CONSULTING);
    for (const extra of [{ list_price: 99 }, { vat_rate: 10 }]) {
      await expect(update_item(db, { id: item.id, revision: 1, name: "X", ...extra })).rejects.toThrow(
        "Refused: price and VAT rate are their own decision — use update_item_price. Nothing was saved."
      );
    }
    expect(await get_item(db, { id: item.id })).toMatchObject({ revision: 1, name: "Beratung" });
  });

  it("refuses an empty or no-op change, and a sku taken by another item", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-update-noop"));
    const item = await create_item(db, CONSULTING);
    const other = await create_item(db, { ...CONSULTING, sku: "B-02" });
    await expect(update_item(db, { id: item.id, revision: 1 })).rejects.toThrow(/at least one of/);
    await expect(update_item(db, { id: item.id, revision: 1, name: "Beratung" })).rejects.toThrow(/nothing would change/);
    await expect(update_item(db, { id: item.id, revision: 1, sku: "B-02" })).rejects.toThrow(
      new RegExp(`item ${other.id} already has item number B-02`)
    );
    expect((await get_item(db, { id: item.id })).revision).toBe(1);
  });
});

describe("update_item_price", () => {
  it("changes list price and VAT rate to the next revision; both required; unchanged refused", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-price"));
    const item = await create_item(db, CONSULTING);
    await expect(update_item_price(db, { id: item.id, revision: 1, list_price: 130 })).rejects.toThrow(/needs both list_price and vat_rate/);
    await expect(update_item_price(db, { id: item.id, revision: 1, list_price: 120, vat_rate: 20 })).rejects.toThrow(/nothing would change/);
    const changed = await update_item_price(db, { id: item.id, revision: 1, list_price: 130, vat_rate: 20, ticket_id: "t-3" });
    expect(changed).toMatchObject({ list_price: 130, vat_rate: 20, revision: 2 });
    expect((await get_item(db, { id: item.id, revision: 1 })).list_price).toBe(120);
  });
});

describe("list_items / get_item", () => {
  it("lists active items by default, inactive on request; get_item returns inactive items", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-list"));
    const a = await create_item(db, CONSULTING);
    const b = await create_item(db, { ...CONSULTING, sku: "W-01", name: "Workshop" });
    await update_item(db, { id: b.id, revision: 1, active: false });
    expect((await list_items(db, {})).map((i) => i.id)).toEqual([a.id]);
    expect((await list_items(db, { active: false })).map((i) => i.id)).toEqual([b.id]);
    expect((await list_items(db, { query: "W-0", active: false })).map((i) => i.id)).toEqual([b.id]);
    expect(await get_item(db, { id: b.id })).toMatchObject({ active: false, revision: 2 });
    await expect(get_item(db, { id: a.id, revision: 7 })).rejects.toThrow(/has no revision 7/);
    await expect(get_item(db, { id: "nope" })).rejects.toThrow(/Unknown item id: nope/);
  });
});

describe("lines with item_id (contract §5.3)", () => {
  const line = (item_id: string, unit_price: number, vat_rate = 20) => ({ item_id, description: "Beratung", qty: 2, unit: "Std.", unit_price, vat_rate });

  it("an invoice line stores item_id, the list price and the item revision at issue; a different line price is accepted", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-line"));
    const cust = await seedAtCustomer(db);
    const item = await create_item(db, CONSULTING);
    const invoice: any = await create_invoice(db, { customer_id: cust.id, number: "2026-0100", ...INVOICE_ARGS_BASE,
      lines: [line(item.id, 100), { description: "Reise", qty: 1, unit_price: 50, vat_rate: 20 }], net_total: 250 }, ctx);
    // Line price (100) and list price (120) are both on the issued line — the deviation is visible, not refused.
    expect(invoice.lines[0]).toMatchObject({ item_id: item.id, unit_price: 100, list_price: 120, item_revision: 1, description: "Beratung" });
    expect(invoice.lines[1]).toMatchObject({ item_id: null, list_price: null, item_revision: null });
  });

  it("a later price change does not alter the issued invoice (row or archived PDF)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-price-after-issue"));
    const cust = await seedAtCustomer(db);
    const item = await create_item(db, CONSULTING);
    const invoice: any = await create_invoice(db, { customer_id: cust.id, number: "2026-0101", ...INVOICE_ARGS_BASE,
      lines: [line(item.id, 120)], net_total: 240 }, ctx);
    const before: any = await get_document(db, { kind: "invoice-pdf", id: invoice.id });

    await update_item_price(db, { id: item.id, revision: 1, list_price: 150, vat_rate: 10 });

    const after: any = await get_invoice(db, { id: invoice.id });
    expect(after.lines[0]).toMatchObject({ unit_price: 120, vat_rate: 20, list_price: 120, item_revision: 1 });
    expect(after.net_total).toBe(invoice.net_total);
    expect((await get_document(db, { kind: "invoice-pdf", id: invoice.id }) as any).sha256).toBe(before.sha256);
    // A new invoice now records the new list price + revision.
    const next: any = await create_invoice(db, { customer_id: cust.id, number: "2026-0102", ...INVOICE_ARGS_BASE,
      lines: [line(item.id, 120)], net_total: 240 }, ctx);
    expect(next.lines[0]).toMatchObject({ list_price: 150, item_revision: 2, vat_rate: 20 });
  });

  it("an inactive item is refused on a new invoice / credit note / preview, nothing issued; old documents still read", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-inactive"));
    const cust = await seedAtCustomer(db);
    const item = await create_item(db, CONSULTING);
    const invoice: any = await create_invoice(db, { customer_id: cust.id, number: "2026-0103", ...INVOICE_ARGS_BASE,
      lines: [line(item.id, 120)], net_total: 240 }, ctx);
    await update_item(db, { id: item.id, revision: 1, active: false });

    const args = { customer_id: cust.id, number: "2026-0104", ...INVOICE_ARGS_BASE, lines: [line(item.id, 120)], net_total: 240 };
    await expect(create_invoice(db, args, ctx)).rejects.toThrow("Refused: lines[0]: Item B-01 is inactive — it cannot go on a new document.");
    await expect(preview_invoice(db, args, ctx)).rejects.toThrow(/Item B-01 is inactive/);
    await expect(create_credit_note(db, { invoice_id: invoice.id, number: "2026-0105", document_date: INVOICE_ARGS_BASE.document_date,
      credit_total: 240, currency: "EUR", reason: "x", lines: [line(item.id, 120)] }, ctx)).rejects.toThrow(/Item B-01 is inactive/);
    expect(await db.all("SELECT number FROM local_numbers ORDER BY number")).toEqual([{ number: "2026-0103" }]);
    expect((await get_invoice(db, { id: invoice.id }) as any).lines[0].item_id).toBe(item.id);
  });

  it("an unknown item_id is refused", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-unknown"));
    const cust = await seedAtCustomer(db);
    await expect(create_invoice(db, { customer_id: cust.id, number: "2026-0106", ...INVOICE_ARGS_BASE,
      lines: [line("missing", 120)], net_total: 240 }, ctx)).rejects.toThrow("Refused: lines[0].item_id: unknown item missing.");
  });

  it("validateLocalLines (sync, no lookup) refuses item_id instead of dropping it; resolveLocalLines resolves it", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-lines-api"));
    const item = await create_item(db, CONSULTING);
    expect(() => validateLocalLines([line(item.id, 100)])).toThrow(/needs the catalogue lookup/);
    expect(validateLocalLines([{ description: "X", qty: 1, unit_price: 1, vat_rate: 20 }])[0]).toMatchObject({ item_id: null, unit: "Stk." });
    const [resolved] = await resolveLocalLines(db, [line(item.id, 100, 0)]);
    expect(resolved).toMatchObject({ item_id: item.id, list_price: 120, item_revision: 1, unit_price: 100, vat_rate: 0 });
  });
});

describe("DB (R12)", () => {
  it("opening an existing DB twice keeps the items (migration is a no-op)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("item-reopen"));
    const item = await create_item(db, CONSULTING);
    await db.close();
    db = await createLocalDb(`${dataDir}/erp-local.sqlite`);
    expect(await get_item(db, { id: item.id })).toMatchObject({ list_price: 120, revision: 1 });
  });
});
