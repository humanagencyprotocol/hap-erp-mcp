/**
 * Fixes from the independent review of feat/local-production (2026-10-21,
 * temp/erp-review-2026-10-21.md) — one block per finding; each test fails on
 * the reviewed code. The stdio-wire proofs (finding 1's 20 parallel pairs,
 * structured results) are in review-fixes-stdio.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "fs";
import { join, win32 } from "path";
import type { Db } from "../../src/db.js";
import { createLocalDb } from "../../src/live/local/db.js";
import { callLocalTool } from "../../src/live/local/dispatch.js";
import { parentDirOf } from "../../src/live/local/archive.js";
import { requireSafeDocumentNumber, isSafeDocumentNumber } from "../../src/live/local/document-number.js";
import {
  create_invoice, create_credit_note, get_invoice, get_credit_note, list_invoices, list_credit_notes, get_document, type LocalCtx,
} from "../../src/live/local/tools/invoices.js";
import { create_quote, update_quote, get_quote } from "../../src/live/local/tools/quotes.js";
import { create_item, update_item, update_item_price } from "../../src/live/local/tools/items.js";
import {
  addCustomer, clearCustomerUid, create_customer, update_customer, update_customer_tax_data, find_customers,
  check_customer_duplicates, get_customer,
} from "../../src/live/local/tools/customers.js";
import {
  freshLocalCtx, cleanupDataDir, seedAtCustomer, INVOICE_ARGS_BASE, TODAY, stubVies, withVies, markViesValid,
} from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  await db?.close().catch(() => {});
  if (dataDir) cleanupDataDir(dataDir);
});

const YEAR = TODAY.slice(0, 4);
const L = [{ description: "Beratung", qty: 1, unit_price: 100, vat_rate: 20 }];
const L0 = [{ description: "Beratung", qty: 1, unit_price: 100, vat_rate: 0 }];
const invoiceArgs = (customer_id: string, number: string, lines = L) => ({
  customer_id, number, ...INVOICE_ARGS_BASE, lines, net_total: 100,
});
const quoteArgs = (customer_id: string, number: string, lines: unknown[] = L) => ({
  customer_id, number, document_date: TODAY, lines, value: 100, discount_pct: 0, currency: "EUR",
});
const count = async (table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const pdfs = (...dir: string[]) => {
  const d = join(dataDir, "erp-local-archive", ...dir);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".pdf")).sort() : [];
};

/** A Db whose next COMMIT fails once — a DB step that fails after the archive write. */
function failingCommitOnce(inner: Db): Db {
  let armed = true;
  return {
    ...inner,
    run: async (sql, params) => {
      if (armed && sql === "COMMIT") {
        armed = false;
        throw new Error("disk I/O error (test)");
      }
      return inner.run(sql, params);
    },
  };
}

/** A 0.9.5-style invoice row: base columns only, no customer snapshot. */
async function insertOldInvoice(target: Db, customerId: string, number: string, extra: Record<string, unknown> = {}) {
  const cols: Record<string, unknown> = {
    id: `old-${number}`, number, customer_id: customerId, status: "issued", currency: "EUR", net_total: 200, vat_total: 40,
    gross_total: 240, credited_total: 0, tax_mode: "normal", payment_term_days: 14, service_period_from: "2026-10-01",
    service_period_to: "2026-10-20", issued_at: "2026-10-20T00:00:00.000Z", due_date: "2026-11-03T00:00:00.000Z",
    template_id: "rechnung-de", template_version: "4", template_fingerprint: "x",
    archive_path: join(dataDir, "erp-local-archive", "2026", `${number}.pdf`), archive_sha256: "0".repeat(64), ...extra,
  };
  const keys = Object.keys(cols);
  await target.run(`INSERT INTO local_invoices (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(cols));
  await target.run(`INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES (?, 'invoice', ?, ?)`, [number, cols.id, cols.issued_at]);
}

describe("finding 1: one write lock, the PDF only with its row", () => {
  it("update_quote racing create_invoice (direct calls, as the reviewer's P10) never fails, never freezes the quote", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-p10"));
    const c = await seedAtCustomer(db);
    const q = await create_quote(db, quoteArgs(c.id, "Q-10"), ctx);
    for (let t = 0; t < 20; t++) {
      const cur = await get_quote(db, { id: q.id });
      const results = await Promise.allSettled([
        update_quote(db, { id: q.id, revision: cur.revision, document_date: TODAY, value: 100, discount_pct: 0, currency: "EUR", notes: `n${t}` }, ctx),
        create_invoice(db, invoiceArgs(c.id, `R-${t}`), ctx),
        create_item(db, { name: `I${t}`, kind: "service", unit: "Std.", list_price: 1, vat_rate: 20 }),
      ]);
      expect(results.filter((r) => r.status === "rejected").map((r: any) => r.reason.message)).toEqual([]);
    }
    expect((await get_quote(db, { id: q.id })).revision).toBe(21);
    expect(pdfs("quotes", YEAR)).toHaveLength(21);
    expect(pdfs(YEAR)).toHaveLength(20);
    expect(await count("local_invoices")).toBe(20);
  });

  it("an invoice whose DB step fails leaves no PDF and no number — the retry with the same number issues", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-inv-fail"));
    const c = await seedAtCustomer(db);
    await expect(create_invoice(failingCommitOnce(db), invoiceArgs(c.id, "2026-101"), ctx)).rejects.toThrow(/disk I\/O error/);
    expect(pdfs(YEAR)).toEqual([]);
    expect(await count("local_numbers")).toBe(0);
    const inv = await create_invoice(db, invoiceArgs(c.id, "2026-101"), ctx);
    expect(inv.number).toBe("2026-101");
    expect(pdfs(YEAR)).toEqual(["2026-101.pdf"]);
  });

  it("a credit note whose DB step fails leaves no PDF; the invoice stays uncredited", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-cn-fail"));
    const c = await seedAtCustomer(db);
    const inv = await create_invoice(db, invoiceArgs(c.id, "2026-1"), ctx);
    const cn = { invoice_id: inv.id, number: "G-1", document_date: TODAY, credit_total: 100, currency: "EUR", reason: "Storno" };
    await expect(create_credit_note(failingCommitOnce(db), cn, ctx)).rejects.toThrow(/disk I\/O error/);
    expect(pdfs(YEAR)).toEqual(["2026-1.pdf"]);
    expect((await get_invoice(db, { id: inv.id })).credited_total).toBe(0);
    await create_credit_note(db, cn, ctx);
    expect(pdfs(YEAR)).toEqual(["2026-1.pdf", "G-1.pdf"]);
  });

  it("a failed update_quote leaves no -r2 file, so the next revision still works", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-quote-fail"));
    const c = await seedAtCustomer(db);
    const q = await create_quote(db, quoteArgs(c.id, "Q-1"), ctx);
    const upd = { id: q.id, revision: 1, document_date: TODAY, value: 100, discount_pct: 0, currency: "EUR", notes: "x" };
    await expect(update_quote(failingCommitOnce(db), upd, ctx)).rejects.toThrow(/disk I\/O error/);
    expect(pdfs("quotes", YEAR)).toEqual([`Q-1-r1.pdf`]);
    expect((await update_quote(db, upd, ctx)).revision).toBe(2);
  });
});

describe("finding 2: snapshot backfill on every start, and while running", () => {
  const MUSTER_COMPANY_JSON = {
    name: "Suveren", owner: "Andreas Schadauer MUSTER",
    address: { street: "MUSTER-Straße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
    uid: "ATU00000000", email: "andreas@sublin.app", web: "www.suveren.ai", register: null,
    bank: { name: "MUSTER Bank", iban: "AT00", bic: "MUSTERBIC" }, default_payment_term_days: 14, vat_mode: "normal",
  };

  it("a document written without snapshot into a migrated DB gets one at the next start", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-mig"));
    const c = await seedAtCustomer(db);
    await insertOldInvoice(db, c.id, "R-OLD-AFTER"); // as erp-mcp 0.9.5 writes it into the migrated DB
    await db.close();
    db = await createLocalDb(join(dataDir, "erp-local.sqlite"), { log: () => {} });
    expect((await list_invoices(db, {}))[0].customer).toMatchObject({ name: c.name, source: "migrated" });
    expect((await get_invoice(db, { id: "R-OLD-AFTER" })).customer.source).toBe("migrated");
    const cn = await create_credit_note(db, { invoice_id: "R-OLD-AFTER", number: "G-NEW", document_date: TODAY, credit_total: 200, currency: "EUR", reason: "x" }, ctx);
    expect(cn.customer).toMatchObject({ name: c.name, source: "migrated" });
    expect(await list_credit_notes(db, {})).toHaveLength(1);
  });

  it("…and one written while this process runs is healed before the next tool call", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-mig-live"));
    writeFileSync(join(dataDir, "company.json"), JSON.stringify(MUSTER_COMPANY_JSON));
    const env = { ERP_LIVE_ADAPTER: "local", ERP_LIVE_COMPANY_FILE: join(dataDir, "company.json"), HAP_DATA_DIR: dataDir, ERP_VIES: "off" } as NodeJS.ProcessEnv;
    const c = await seedAtCustomer(db);
    await insertOldInvoice(db, c.id, "R-OLD-LIVE");
    const rows = (await callLocalTool(db, "list_invoices", {}, env)) as any[];
    expect(rows[0].customer).toMatchObject({ name: c.name, source: "migrated" });
  });
});

describe("finding 3 (Andreas, option A): customers outside the EU VAT area are refused", () => {
  const OUTSIDE = /^Refused: Tax treatment for customers outside the EU is not supported yet \(customer country (XI|CH)\) — nothing was issued\.$/;

  it("XI with a VIES-valid VAT ID: invoice and quote refused, nothing numbered or archived", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-xi"));
    const xi = await create_customer(db, { name: "Belfast Ltd", address_lines: ["Belfast"], country: "XI", uid: "XI123456789" }, withVies(ctx));
    expect(xi.vies_status).toBe("valid");
    await expect(create_invoice(db, invoiceArgs(xi.id, "R-XI", L0), ctx)).rejects.toThrow(OUTSIDE);
    await expect(create_invoice(db, invoiceArgs(xi.id, "R-XI2"), ctx)).rejects.toThrow(OUTSIDE);
    await expect(create_quote(db, quoteArgs(xi.id, "Q-XI"), ctx)).rejects.toThrow(OUTSIDE);
    expect(await count("local_numbers")).toBe(0);
    expect(await count("local_quote_numbers")).toBe(0);
    expect(pdfs(YEAR)).toEqual([]);
  });

  it("CH with a VAT ID, and CH without one (consumer), are refused", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-ch"));
    const ch = await addCustomer(db, { name: "Zürich AG", address_lines: ["Zürich"], country: "CH", uid: "CHE-123.456.789 MWST" });
    const chPrivate = await addCustomer(db, { name: "Herr Muster", address_lines: ["Basel"], country: "CH" });
    for (const id of [ch.id, chPrivate.id]) {
      await expect(create_invoice(db, invoiceArgs(id, `R-${id}`), ctx)).rejects.toThrow(OUTSIDE);
      await expect(create_quote(db, quoteArgs(id, `Q-${id}`), ctx)).rejects.toThrow(OUTSIDE);
    }
    expect(await count("local_numbers")).toBe(0);
  });

  it("a quote → invoice conversion to a customer now outside the EU is refused", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-conv-ch"));
    const c = await seedAtCustomer(db);
    const q = await create_quote(db, quoteArgs(c.id, "Q-1"), ctx);
    // A quote that exists for a non-EU customer (e.g. made before this rule): moved without a revision change.
    await db.run("UPDATE local_customers SET country = 'CH', uid = NULL WHERE id = ?", [c.id]);
    await expect(
      create_invoice(db, { customer_id: c.id, quote_id: q.id, quote_revision: 1, number: "R-1", ...INVOICE_ARGS_BASE, net_total: 100 }, ctx)
    ).rejects.toThrow(OUTSIDE);
    expect(await count("local_numbers")).toBe(0);
  });

  it("AT and DE customers are unchanged; a credit note on an existing non-EU invoice is allowed", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-eu"));
    const at = await seedAtCustomer(db);
    await create_invoice(db, invoiceArgs(at.id, "R-AT"), ctx);
    const de = await addCustomer(db, { name: "Kessler", address_lines: ["Hamburg"], country: "DE", uid: "DE123456789" });
    await markViesValid(db, de.id);
    expect((await create_invoice(db, invoiceArgs(de.id, "R-DE", L0), ctx)).tax_mode).toBe("reverse_charge");

    const ch = await addCustomer(db, { name: "Zürich AG", address_lines: ["Zürich"], country: "CH", uid: "CHE-123.456.789" });
    await insertOldInvoice(db, ch.id, "R-CH-OLD", {
      customer_name: "Zürich AG", customer_address_lines: JSON.stringify(["Zürich"]), customer_country: "CH",
      customer_uid: "CHE-123.456.789", customer_revision: 1, customer_snapshot_source: "issued",
    });
    const cn = await create_credit_note(db, { invoice_id: "R-CH-OLD", number: "G-CH", document_date: TODAY, credit_total: 200, currency: "EUR", reason: "Storno" }, ctx);
    expect(cn.customer.country).toBe("CH");
  });
});

describe("finding 4: invoice / credit-note numbers never collide with quotes, any case", () => {
  it("refuses a quote's number and a case variant of an invoice number", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-num"));
    const c = await seedAtCustomer(db);
    await create_quote(db, quoteArgs(c.id, "A-2026-001"), ctx);
    await expect(create_invoice(db, invoiceArgs(c.id, "A-2026-001"), ctx)).rejects.toThrow(/already the number of a quote \(A-2026-001\)/);
    await expect(create_invoice(db, invoiceArgs(c.id, "a-2026-001"), ctx)).rejects.toThrow(/already the number of a quote/);
    const inv = await create_invoice(db, invoiceArgs(c.id, "R-1"), ctx);
    await expect(create_invoice(db, invoiceArgs(c.id, "r-1"), ctx)).rejects.toThrow(/has already been used \(invoice or credit note R-1\)/);
    const cn = { invoice_id: inv.id, document_date: TODAY, credit_total: 100, currency: "EUR", reason: "x" };
    await expect(create_credit_note(db, { ...cn, number: "A-2026-001" }, ctx)).rejects.toThrow(/already the number of a quote/);
    expect(await count("local_numbers")).toBe(1);
  });
});

describe("finding 6: quote → invoice keeps the quote's catalogue values", () => {
  it("an item repriced and deactivated since the quote neither blocks nor changes the conversion", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-conv-item"));
    const c = await seedAtCustomer(db);
    const item = await create_item(db, { name: "Beratung", kind: "service", unit: "Std.", list_price: 120, vat_rate: 20 });
    const q = await create_quote(db, { ...quoteArgs(c.id, "Q-1", [{ item_id: item.id, description: "Beratung", qty: 1, unit: "Std.", unit_price: 100, vat_rate: 20 }]) }, ctx);
    await update_item_price(db, { id: item.id, revision: 1, list_price: 150, vat_rate: 20 });
    await update_item(db, { id: item.id, revision: 2, active: false });
    const inv = await create_invoice(db, { customer_id: c.id, quote_id: q.id, quote_revision: 1, number: "R-1", ...INVOICE_ARGS_BASE, net_total: 100 }, ctx);
    expect(inv.lines[0]).toMatchObject({ item_id: item.id, list_price: 120, item_revision: 1, unit_price: 100 });
  });
});

describe("finding 8: CRM contact and VAT ID duplicates", () => {
  it("a CRM contact id is trimmed and case-folded for the uniqueness check", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-crm"));
    const v = withVies(ctx);
    const a = await create_customer(db, { name: "A", address_lines: ["x"], country: "AT", crm_contact_id: "crm-1" }, v);
    for (const crm of ["crm-1 ", "CRM-1", " Crm-1"]) {
      await expect(create_customer(db, { name: "B", address_lines: ["y"], country: "AT", crm_contact_id: crm }, v)).rejects.toThrow(
        `customer ${a.id} already has CRM contact`
      );
    }
    const b = await create_customer(db, { name: "B", address_lines: ["y"], country: "AT", crm_contact_id: " crm-2 " }, v);
    expect(b.crm_contact_id).toBe("crm-2");
    await expect(update_customer(db, { id: b.id, revision: 1, crm_contact_id: "CRM-1" }, v)).rejects.toThrow(/already has CRM contact/);
    expect((await find_customers(db, { crm_contact_id: " CRM-1" })).map((r) => r.id)).toEqual([a.id]);
    expect(await check_customer_duplicates(db, { crm_contact_id: "CRM-1 ", uid: "ATU 999" })).toEqual({
      uid: "ATU999", crm_contact_id: "crm-1", vat_duplicate_of: null, crm_contact_duplicate_of: a.id,
    });
    expect((await check_customer_duplicates(db, { crm_contact_id: "crm-1", id: a.id })).crm_contact_duplicate_of).toBeNull();
  });

  it("VAT-ID spelling variants are logged at start; `customers clear-uid` unlocks the other customer", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-uidvar"));
    // As 0.9.5 could write them: no duplicate check then.
    for (const [id, uid] of [["c1", "atu 123.456-78"], ["c2", "ATU12345678"]]) {
      await db.run(`INSERT INTO local_customers (id, name, address_lines, country, uid) VALUES (?, ?, '["Wien"]', 'AT', ?)`, [id, id, uid]);
    }
    await db.close();
    const logs: string[] = [];
    db = await createLocalDb(join(dataDir, "erp-local.sqlite"), { log: (m) => logs.push(m) });
    expect(logs.join("\n")).toMatch(/ATU12345678 \(c1 "atu 123.456-78", c2 "ATU12345678"\).*customers clear-uid/);
    const tax = { name: "c2", address_lines: ["Wien"], country: "AT", uid: "ATU12345678" };
    await expect(update_customer_tax_data(db, { id: "c2", revision: 1, ...tax }, withVies(ctx))).rejects.toThrow(/customer c1 already has VAT ID/);
    const cleared = await clearCustomerUid(db, "c1");
    expect(cleared).toMatchObject({ uid: null, revision: 2, vies: null });
    expect((await get_customer(db, { id: "c1", revision: 1 })).uid).toBe("atu 123.456-78");
    expect(await update_customer_tax_data(db, { id: "c2", revision: 1, ...tax }, withVies(ctx))).toMatchObject({ revision: 2, vies_status: "valid" });
    await expect(clearCustomerUid(db, "c1")).rejects.toThrow(/has no VAT ID/);
  });
});

describe("finding 9: D1 is checked on the row the snapshot came from", () => {
  it("a VIES `valid` committed between two reads cannot pair with the earlier snapshot", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-d1"));
    const de = await addCustomer(db, { name: "Kessler", address_lines: ["Hamburg"], country: "DE", uid: "DE123456789" });
    let reads = 0;
    const racing: Db = {
      ...db,
      get: async (sql, params) => {
        const out = await db.get(sql, params);
        if (sql.startsWith("SELECT * FROM local_customers WHERE id = ?") && ++reads === 1) await markViesValid(db, de.id);
        return out as any;
      },
    };
    await expect(create_invoice(racing, invoiceArgs(de.id, "R-RC", L0), ctx)).rejects.toThrow(/confirm the VAT ID first.*never checked/);
    expect(await count("local_invoices")).toBe(0);
  });
});

describe("finding 10: id vs number lookups", () => {
  it("prefers nothing silently: a string that is one quote's id and another's number is refused", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-ambig"));
    const c = await seedAtCustomer(db);
    const a = await create_quote(db, quoteArgs(c.id, "Q-A"), ctx);
    const b = await create_quote(db, quoteArgs(c.id, a.id), ctx);
    await expect(get_quote(db, { id: a.id })).rejects.toThrow(/is ambiguous — it is the id of quote Q-A/);
    expect((await get_quote(db, { id: "Q-A" })).id).toBe(a.id);
    expect((await get_quote(db, { id: b.id })).number).toBe(a.id);

    const ia = await create_invoice(db, invoiceArgs(c.id, "R-A"), ctx);
    await create_invoice(db, invoiceArgs(c.id, ia.id), ctx);
    await expect(get_invoice(db, { id: ia.id })).rejects.toThrow(/is ambiguous/);
    await expect(get_document(db, { kind: "invoice-pdf", id: ia.id })).rejects.toThrow(/is ambiguous/);
    expect((await get_invoice(db, { id: "R-A" })).id).toBe(ia.id);
  });

  it("get_credit_note resolves id first, then number (case-insensitive), and refuses an ambiguous string", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-cn-number"));
    const c = await seedAtCustomer(db);
    const credit = (invoice_id: string, number: string) =>
      create_credit_note(db, { invoice_id, number, document_date: TODAY, credit_total: 100, currency: "EUR", reason: "Storno" }, ctx);
    const ia = await create_invoice(db, invoiceArgs(c.id, "F-2026-001"), ctx);
    const ib = await create_invoice(db, invoiceArgs(c.id, "F-2026-002"), ctx);
    const ic = await create_invoice(db, invoiceArgs(c.id, "F-2026-003"), ctx);
    const ga = await credit(ia.id, "G-2026-006");

    // The e2e repro: a credit note asked for by its number.
    const byNumber = await get_credit_note(db, { id: "G-2026-006" });
    expect(byNumber.id).toBe(ga.id);
    expect(byNumber.lines).toEqual(ga.lines);
    expect((await get_credit_note(db, { id: "g-2026-006" })).id).toBe(ga.id);
    expect((await get_credit_note(db, { id: ga.id })).number).toBe("G-2026-006");
    expect((await get_document(db, { kind: "credit-note-pdf", id: "g-2026-006" })).sha256).toBe(ga.archive_sha256);
    await expect(get_credit_note(db, { id: "G-2026-999" })).rejects.toThrow(/Unknown credit note id: G-2026-999/);

    // One credit note's id is another's number — refused, exactly as for invoices and quotes.
    const gb = await credit(ib.id, ga.id);
    await expect(get_credit_note(db, { id: ga.id })).rejects.toThrow(/is ambiguous — it is the id of credit note G-2026-006/);
    await expect(get_document(db, { kind: "credit-note-pdf", id: ga.id })).rejects.toThrow(/is ambiguous/);
    expect((await get_credit_note(db, { id: gb.id })).number).toBe(ga.id);

    // ...also when the number differs from the id only in case.
    const gc = await credit(ic.id, gb.id.toUpperCase());
    await expect(get_credit_note(db, { id: gb.id })).rejects.toThrow(/is ambiguous/);
    expect((await get_credit_note(db, { id: gc.id })).number).toBe(gb.id.toUpperCase());
  });

  it("invoice and quote numbers are matched case-insensitively, like the uniqueness rule", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("rf-number-case"));
    const c = await seedAtCustomer(db);
    const q = await create_quote(db, quoteArgs(c.id, "Q-2026-001"), ctx);
    const i = await create_invoice(db, invoiceArgs(c.id, "F-2026-001"), ctx);
    expect((await get_quote(db, { id: "q-2026-001" })).id).toBe(q.id);
    expect((await get_invoice(db, { id: "f-2026-001" })).id).toBe(i.id);
    expect((await get_document(db, { kind: "invoice-pdf", id: "f-2026-001" })).sha256).toBe(i.archive_sha256);
  });
});

describe("Windows: reserved device names and archive directories", () => {
  it("document numbers refuse CON, PRN, AUX, NUL, COM1–9, LPT1–9 in any case, with or without extension", () => {
    for (const n of ["CON", "con", "Nul", "PRN.2026", "aux.pdf", "COM1", "com9", "LPT1", "lpt9.x"]) {
      expect(isSafeDocumentNumber(n), n).toBe(false);
      expect(() => requireSafeDocumentNumber(n, "invoice")).toThrow(/Windows device name/);
    }
    for (const n of ["CONSULT-1", "COM10", "LPT0", "NUL1", "R-CON"]) expect(isSafeDocumentNumber(n), n).toBe(true);
  });

  it("the archive directory of a Windows path is its real parent, not a junk directory", () => {
    expect(parentDirOf("C:\\data\\erp-local-archive\\2026\\R-1.pdf", win32)).toBe("C:\\data\\erp-local-archive\\2026");
  });
});
