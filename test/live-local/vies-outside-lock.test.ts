/**
 * Follow-ups to the 2026-10-21 review fixes:
 *
 * - F13: the VIES call never holds the Local lock — a slow VIES answer must
 *   not delay a concurrent read; the write re-validates after the call and
 *   stores that execution-time answer.
 * - F14: customer reads report tax_mode `unsupported` ("Not supported
 *   (outside the EU)") for a customer outside the EU VAT area, consistent
 *   with the refusal on invoices and quotes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { writeFileSync } from "fs";
import { join } from "path";
import type { Db } from "../../src/db.js";
import { callLocalTool } from "../../src/live/local/dispatch.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import type { ViesClient, ViesResult } from "../../src/live/local/vies.js";
import {
  addCustomer, create_customer, update_customer_tax_data, get_customer, find_customers, preview_customer_change,
} from "../../src/live/local/tools/customers.js";
import { freshLocalCtx, cleanupDataDir, seedAtCustomer, withVies } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
let server: Server | null = null;
afterEach(async () => {
  await db?.close().catch(() => {});
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  if (dataDir) cleanupDataDir(dataDir);
});

const MUSTER_COMPANY_JSON = {
  name: "Suveren", owner: "Andreas Schadauer MUSTER",
  address: { street: "MUSTER-Straße 1", zip: "1010", city: "Wien", country: "Österreich", country_code: "AT" },
  uid: "ATU00000000", email: "andreas@sublin.app", web: "www.suveren.ai", register: null,
  bank: { name: "MUSTER Bank", iban: "AT00", bic: "MUSTERBIC" }, default_payment_term_days: 14, vat_mode: "normal",
};

function envFor(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  writeFileSync(join(dataDir, "company.json"), JSON.stringify(MUSTER_COMPANY_JSON));
  return { ERP_LIVE_ADAPTER: "local", ERP_LIVE_COMPANY_FILE: join(dataDir, "company.json"), HAP_DATA_DIR: dataDir, ...extra };
}

/** A VIES client whose answer the test releases; `called` resolves when the check started. */
function heldVies(status: ViesResult["status"] = "valid") {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const called = new Promise<void>((r) => (started = r));
  const client: ViesClient = {
    async check() {
      started();
      await gate;
      return { status, reason: null, checked_at: "2026-10-21T09:00:00.000Z", request_id: "REQ-HELD", name: null, address: null };
    },
  };
  return { client, release, called };
}

const DE = { name: "Kessler GmbH", address_lines: ["Hamburg"], country: "DE", uid: "DE123456789" };

describe("F13: VIES runs outside the Local lock", () => {
  it("a create_customer waiting on VIES does not delay a concurrent get_customer through dispatch", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vl-create"));
    const env = envFor();
    const existing = await seedAtCustomer(db);
    const vies = heldVies();
    const creating = create_customer(db, DE, withVies(ctx, vies.client));
    await vies.called;
    const read = (await callLocalTool(db, "get_customer", { id: existing.id }, env)) as any; // would hang behind the lock before
    expect(read.id).toBe(existing.id);
    vies.release();
    expect(await creating).toMatchObject({ uid: "DE123456789", vies_status: "valid", vies: { request_id: "REQ-HELD" } });
  });

  it("…same for update_customer_tax_data; the write re-validates after VIES (a change meanwhile is refused)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vl-update"));
    const env = envFor();
    const c = await create_customer(db, DE, withVies(ctx));
    const vies = heldVies();
    const updating = update_customer_tax_data(db, { id: c.id, revision: 1, ...DE, name: "Kessler AG" }, withVies(ctx, vies.client));
    await vies.called;
    // Another change commits while VIES is answering — not blocked by it.
    await callLocalTool(db, "update_customer", { id: c.id, revision: 1, email: "ap@kessler.example" }, env);
    vies.release();
    await expect(updating).rejects.toThrow(`Customer ${c.id} is at revision 2; this request is for revision 1.`);
    expect(await get_customer(db, { id: c.id })).toMatchObject({ name: "Kessler GmbH", revision: 2 });
  });

  it("a duplicate created while VIES answers is refused at the write", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vl-dup"));
    const vies = heldVies();
    const creating = create_customer(db, DE, withVies(ctx, vies.client));
    await vies.called;
    const other = await addCustomer(db, { ...DE, name: "Other" });
    vies.release();
    await expect(creating).rejects.toThrow(`customer ${other.id} already has VAT ID DE123456789`);
  });

  it("over the real VIES HTTP path via dispatch: a 1.5 s VIES answer does not delay get_customer", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vl-http"));
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ valid: true, requestIdentifier: "WAPI-SLOW", name: "KESSLER", address: "HAMBURG" }));
      }, 1500));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const env = envFor({ ERP_VIES_URL: `http://127.0.0.1:${port}/check` });
    const existing = await seedAtCustomer(db);

    const t0 = Date.now();
    const creating = callLocalTool(db, "create_customer", DE, env);
    await new Promise((r) => setTimeout(r, 100));
    await callLocalTool(db, "get_customer", { id: existing.id }, env);
    const readMs = Date.now() - t0;
    const created = (await creating) as any;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    expect(readMs).toBeLessThan(1000);
    expect(created).toMatchObject({ vies_status: "valid", vies: { request_id: "WAPI-SLOW" } });
  }, 10_000);
});

describe("F14: customers outside the EU VAT area read as tax_mode unsupported", () => {
  const UNSUPPORTED = { tax_mode: "unsupported", tax_mode_label: "Not supported (outside the EU)" };

  it("XI (VIES-valid), CH with and without VAT ID — never 'Normal VAT'; AT/DE unchanged", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vl-unsup"));
    const xi = await create_customer(db, { name: "Belfast Ltd", address_lines: ["Belfast"], country: "XI", uid: "XI123456789" }, withVies(ctx));
    expect(xi).toMatchObject({ vies_status: "valid", ...UNSUPPORTED });
    const ch = await addCustomer(db, { name: "Zürich AG", address_lines: ["Zürich"], country: "CH", uid: "CHE-123.456.789" });
    const chPrivate = await addCustomer(db, { name: "Herr Muster", address_lines: ["Basel"], country: "CH" });
    for (const id of [ch.id, chPrivate.id]) expect(await get_customer(db, { id }, ctx)).toMatchObject(UNSUPPORTED);
    expect((await find_customers(db, { query: "Zürich" }, ctx))[0]).toMatchObject(UNSUPPORTED);

    const at = await seedAtCustomer(db);
    expect(await get_customer(db, { id: at.id }, ctx)).toMatchObject({ tax_mode: "normal", tax_mode_label: "Normal VAT" });
    const de = await create_customer(db, { name: "Kessler", address_lines: ["Hamburg"], country: "DE", uid: "DE123456789" }, withVies(ctx));
    expect(de.tax_mode).toBe("reverse_charge");

    const p = await preview_customer_change(db, { id: at.id, name: at.name, address_lines: at.address_lines, country: "CH" }, withVies(ctx));
    expect(p.tax_mode).toEqual({ now: "normal", after: "unsupported", now_label: "Normal VAT", after_label: "Not supported (outside the EU)" });
  });
});
