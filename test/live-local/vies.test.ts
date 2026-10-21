/**
 * VIES (§3.5, R3, R5, AM1/O11). The HTTP client is exercised against a local
 * stub server on 127.0.0.1 (ERP_VIES_URL) — no network. The tool-level tests
 * inject a client directly.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import {
  httpViesClient, viesClientFromEnv, mapViesResponse, type ViesClient, type ViesResult,
} from "../../src/live/local/vies.js";
import { create_customer, update_customer_tax_data, get_customer, find_customers, check_vat_id } from "../../src/live/local/tools/customers.js";
import { freshLocalCtx, cleanupDataDir, stubVies, withVies } from "./fixtures.js";

// --- Stub VIES server: answers by vatNumber ---
let server: Server;
let url: string;
const received: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      received.push(q);
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      switch (q.vatNumber) {
        case "U11111111": return send(200, { valid: true, requestIdentifier: "WAPIAAAAZ1", name: "ACME GMBH", address: "WIEN", userError: "VALID" });
        case "U22222222": return send(200, { valid: false, userError: "INVALID", name: "---", address: "---" });
        case "U33333333": return send(503, { error: "down" });
        case "U44444444": return; // hang → timeout
        case "U55555555": return send(200, { valid: false, userError: "MS_UNAVAILABLE" });
        case "U66666666":
          if (q.requesterNumber) return send(400, { actionSucceed: false, errorWrappers: [{ error: "INVALID_REQUESTER_INFO" }] });
          return send(200, { valid: true, requestIdentifier: "", name: "ACME", address: "WIEN" });
        case "U77777777": return send(400, { actionSucceed: false, errorWrappers: [{ error: "INVALID_INPUT" }] });
        default: return send(200, { valid: false });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/check-vat-number`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const q = (vatNumber: string) => ({ countryCode: "AT", vatNumber, requester: "ATU00000000" });
const client = () => httpViesClient({ url, timeoutMs: 300, log: () => {} });

describe("HTTP VIES client against a stub (ERP_VIES_URL)", () => {
  it("sends country, number and the requester; valid → valid with the consultation number", async () => {
    received.length = 0;
    const r = await client().check(q("U11111111"));
    expect(received[0]).toEqual({ countryCode: "AT", vatNumber: "U11111111", requesterMemberStateCode: "AT", requesterNumber: "U00000000" });
    expect(r).toMatchObject({ status: "valid", request_id: "WAPIAAAAZ1", name: "ACME GMBH", address: "WIEN", reason: null });
    expect(r.checked_at).toBeTruthy();
  });

  it("valid:false without a service error → invalid; undisclosed name '---' → null", async () => {
    expect(await client().check(q("U22222222"))).toMatchObject({ status: "invalid", name: null, address: null });
  });

  it("HTTP 503 → not_checked with the reason (never valid)", async () => {
    expect(await client().check(q("U33333333"))).toMatchObject({ status: "not_checked", reason: "VIES unreachable (HTTP 503)" });
  });

  it("a hanging VIES → not_checked: timeout", async () => {
    const r = await client().check(q("U44444444"));
    expect(r.status).toBe("not_checked");
    expect(r.reason).toMatch(/timeout after 0\.3 s/);
  });

  it("MS_UNAVAILABLE → not_checked", async () => {
    expect(await client().check(q("U55555555"))).toMatchObject({ status: "not_checked", reason: "VIES unavailable (MS_UNAVAILABLE)" });
  });

  it("requester refused (INVALID_REQUESTER_INFO) → retried once without it; request_id null, reason says so", async () => {
    received.length = 0;
    const r = await client().check(q("U66666666"));
    expect(received).toHaveLength(2);
    expect(received[1].requesterNumber).toBeUndefined();
    expect(r).toMatchObject({ status: "valid", request_id: null });
    expect(r.reason).toMatch(/requester VAT ID refused/);
  });

  it("INVALID_INPUT → invalid, and a connector error is logged", async () => {
    const logs: string[] = [];
    const r = await httpViesClient({ url, timeoutMs: 300, log: (m) => logs.push(m) }).check(q("U77777777"));
    expect(r.status).toBe("invalid");
    expect(logs.join()).toMatch(/INVALID_INPUT/);
  });

  it("unreachable host → not_checked", async () => {
    const r = await httpViesClient({ url: "http://127.0.0.1:1/x", timeoutMs: 300 }).check(q("U11111111"));
    expect(r.status).toBe("not_checked");
    expect(r.reason).toMatch(/^VIES unreachable/);
  });

  it("the per-call timeout (check_vat_id: 4 s) caps the client's own", async () => {
    const r = await httpViesClient({ url, timeoutMs: 8000 }).check({ ...q("U44444444"), timeoutMs: 200 });
    expect(r.reason).toMatch(/timeout after 0\.2 s/);
  });

  it("ERP_VIES=off → every check not_checked, no call", async () => {
    received.length = 0;
    const r = await viesClientFromEnv({ ERP_VIES: "off", ERP_VIES_URL: url }).check(q("U11111111"));
    expect(r).toMatchObject({ status: "not_checked", reason: "VIES check switched off" });
    expect(received).toHaveLength(0);
  });

  it("the default endpoint is the EU VIES REST API", async () => {
    const { DEFAULT_VIES_URL } = await import("../../src/live/local/vies.js");
    expect(DEFAULT_VIES_URL).toBe("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number");
  });

  it("mapping: no result at all is not_checked, never valid", () => {
    expect(mapViesResponse({}, new Date()).status).toBe("not_checked");
  });
});

// --- Tool level: execution-time VIES (§3.3 step 6, AM1/O11) ---

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const NEW_DE = { name: "Kessler Anlagenbau GmbH", address_lines: ["Hafenstraße 4", "20457 Hamburg"], country: "DE", uid: "DE123456789" };

describe("create_customer / update_customer_tax_data run VIES at execution", () => {
  it("valid → stored valid with the request id", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-valid"));
    const c = await create_customer(db, NEW_DE, withVies(ctx));
    expect(c.vies).toMatchObject({ status: "valid", request_id: "REQ-1" });
    expect((await get_customer(db, { id: c.id })).vies?.status).toBe("valid");
  });

  it("invalid → refused naming the VAT ID, nothing saved", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-invalid"));
    await expect(create_customer(db, NEW_DE, withVies(ctx, stubVies({ DE123456789: "invalid" })))).rejects.toThrow(
      /^Refused: VIES reports VAT ID DE123456789 as not valid \(checked .+\)\. Nothing was saved\.$/
    );
    expect(await find_customers(db, {})).toEqual([]);
    expect(await db.all("SELECT * FROM local_master_revisions")).toEqual([]);
  });

  for (const [label, client] of [
    ["503", () => httpViesClient({ url, timeoutMs: 300 })],
    ["timeout", () => httpViesClient({ url, timeoutMs: 300 })],
    ["MS_UNAVAILABLE", () => httpViesClient({ url, timeoutMs: 300 })],
  ] as const) {
    const vat = { "503": "ATU33333333", timeout: "ATU44444444", MS_UNAVAILABLE: "ATU55555555" }[label];
    it(`VIES ${label} → saved as not_checked with the reason (R5: offline is never valid, saving not blocked)`, async () => {
      ({ db, ctx, dataDir } = await freshLocalCtx(`vies-${label}`));
      const c = await create_customer(db, { ...NEW_DE, country: "AT", uid: vat }, withVies(ctx, client()));
      expect(c.vies?.status).toBe("not_checked");
      expect(c.vies?.reason).toBeTruthy();
    });
  }

  it("ERP_VIES=off → saved as not_checked, 'VIES check switched off'", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-off"));
    const c = await create_customer(db, NEW_DE, withVies(ctx, viesClientFromEnv({ ERP_VIES: "off" })));
    expect(c.vies).toMatchObject({ status: "not_checked", reason: "VIES check switched off" });
  });

  it("no VAT ID or a non-EU VAT ID → no VIES call; non-EU stored as not_applicable", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-none"));
    const never = withVies(ctx, stubVies({ DE123456789: "throw" }));
    const noUid = await create_customer(db, { ...NEW_DE, uid: undefined }, withVies(ctx, { check: () => { throw new Error("called"); } }));
    expect(noUid.vies).toBeNull();
    const ch = await create_customer(db, { name: "Zürich AG", address_lines: ["Bahnhofstr. 1"], country: "CH", uid: "CHE-123.456.789" }, never);
    expect(ch).toMatchObject({ uid: "CHE123456789", vies: { status: "not_applicable" } });
  });

  it("the card's (preview) answer and the execution answer differ → the execution answer is stored", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-disagree"));
    const answers: ViesResult["status"][] = ["valid", "not_checked"];
    const flipping: ViesClient = { check: async (qq) => (await stubVies({ [qq.countryCode + qq.vatNumber]: answers.shift()! }).check(qq)) };
    const card = await check_vat_id(db, { country: "DE", uid: "DE123456789" }, withVies(ctx, flipping));
    expect(card.vies.status).toBe("valid");
    const saved = await create_customer(db, NEW_DE, withVies(ctx, flipping));
    expect(saved.vies?.status).toBe("not_checked");
    expect((await get_customer(db, { id: saved.id })).vies?.status).toBe("not_checked");
  });

  it("card showed valid, execution says invalid → refused", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-disagree-invalid"));
    const card = await check_vat_id(db, { country: "DE", uid: "DE123456789" }, withVies(ctx));
    expect(card.vies.status).toBe("valid");
    await expect(create_customer(db, NEW_DE, withVies(ctx, stubVies({ DE123456789: "invalid" })))).rejects.toThrow(/not valid/);
  });

  it("update_customer_tax_data stores the execution result too, and refuses invalid with nothing changed", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-update"));
    const c = await create_customer(db, { ...NEW_DE, uid: null }, withVies(ctx));
    await expect(
      update_customer_tax_data(db, { id: c.id, revision: 1, ...NEW_DE }, withVies(ctx, stubVies({ DE123456789: "invalid" })))
    ).rejects.toThrow(/not valid.*Nothing was saved/);
    expect((await get_customer(db, { id: c.id })).revision).toBe(1);
    const u = await update_customer_tax_data(db, { id: c.id, revision: 1, ...NEW_DE }, withVies(ctx, stubVies({ DE123456789: "not_checked" })));
    expect(u).toMatchObject({ revision: 2, uid: "DE123456789", vies: { status: "not_checked" } });
  });

  it("removing the VAT ID clears the stored VIES result", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("vies-remove"));
    const c = await create_customer(db, NEW_DE, withVies(ctx));
    const u = await update_customer_tax_data(db, { id: c.id, revision: 1, ...NEW_DE, uid: null }, withVies(ctx));
    expect(u).toMatchObject({ uid: null, vies: null, revision: 2 });
  });
});

describe("check_vat_id output (§3.4)", () => {
  it("has exactly the contract's shape", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("check-shape"));
    const r = await check_vat_id(db, { country: "de", uid: "de 123 456 789" }, withVies(ctx));
    expect(r).toEqual({
      uid: "DE123456789", format: "ok",
      vies: { status: "valid", reason: null, checked_at: "2026-10-21T09:00:00.000Z", request_id: "REQ-1", name: "STUB NAME", address: "STUB ADDRESS" },
      duplicate: false, duplicate_of: null,
    });
  });

  it("a malformed VAT ID is never sent to VIES", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("check-bad"));
    const calls: any[] = [];
    const r = await check_vat_id(db, { country: "DE", uid: "ATU12345678" }, withVies(ctx, stubVies({}, calls)));
    expect(r.format).toBe("wrong_prefix");
    expect(r.vies.status).toBe("not_checked");
    expect(calls).toEqual([]);
  });

  it("names an existing customer with that VAT ID", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("check-dup"));
    const c = await create_customer(db, NEW_DE, withVies(ctx));
    expect(await check_vat_id(db, { country: "DE", uid: "DE123456789" }, withVies(ctx))).toMatchObject({ duplicate: true, duplicate_of: c.id });
  });

  it("uses the 4 s preview timeout", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("check-timeout"));
    const calls: any[] = [];
    await check_vat_id(db, { country: "DE", uid: "DE123456789" }, withVies(ctx, stubVies({}, calls)));
    expect(calls[0].timeoutMs).toBe(4000);
  });
});
