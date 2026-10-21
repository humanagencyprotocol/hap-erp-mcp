/**
 * Customer writes (contract §3.2, §3.3, R2, R3, R9, R10, R11).
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db.js";
import type { LocalCtx } from "../../src/live/local/tools/invoices.js";
import {
  create_customer, update_customer, update_customer_tax_data, get_customer, find_customers, addCustomer,
} from "../../src/live/local/tools/customers.js";
import { LOCAL_TOOL_DEFINITIONS } from "../../src/live/local/definitions.js";
import { freshLocalCtx, cleanupDataDir, stubVies, withVies } from "./fixtures.js";

let db: Db;
let ctx: LocalCtx;
let dataDir: string;
afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

const AT = { name: "Drautal Maschinenbau GmbH", address_lines: ["Industriestraße 12", "9800 Spittal"], country: "AT", uid: "ATU12345678" };
const revisions = (id: string) =>
  db.all<any>(`SELECT revision, content, ticket_id FROM local_master_revisions WHERE entity = 'customer' AND entity_id = ? ORDER BY revision`, [id]);

describe("create_customer", () => {
  it("creates revision 1 with a revision row in the A1 content shape, ticket_id on it", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-create"));
    const c = await create_customer(db, { ...AT, uid: "atu 1234 5678", email: "a@b.example", crm_contact_id: "crm-1", ticket_id: "t-1" }, withVies(ctx));
    expect(c).toMatchObject({ ...AT, email: "a@b.example", crm_contact_id: "crm-1", revision: 1 });
    const [rev] = await revisions(c.id);
    expect(rev.revision).toBe(1);
    expect(rev.ticket_id).toBe("t-1");
    expect(JSON.parse(rev.content)).toEqual({ ...AT, email: "a@b.example", crm_contact_id: "crm-1" });
  });

  it("refusals in contract order: shape, then format — nothing saved", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-refuse"));
    const v = withVies(ctx, stubVies({ ATU12345678: "throw" }));
    await expect(create_customer(db, { ...AT, name: " " }, v)).rejects.toThrow(/^Refused: customer\.name is required\. Nothing was saved\.$/);
    await expect(create_customer(db, { ...AT, address_lines: [] }, v)).rejects.toThrow(/address_lines.*Nothing was saved/);
    await expect(create_customer(db, { ...AT, country: "AUT" }, v)).rejects.toThrow(/country.*Nothing was saved/);
    await expect(create_customer(db, { ...AT, uid: "DE123456789" }, v)).rejects.toThrow(/does not start with AT.*Nothing was saved/);
    await expect(create_customer(db, { ...AT, uid: "ATU123" }, v)).rejects.toThrow(/does not match the format.*Nothing was saved/);
    expect(await find_customers(db, {})).toEqual([]);
  });

  it("R3: no input field carries a VIES result or a verified flag", () => {
    for (const name of ["create_customer", "update_customer", "update_customer_tax_data"]) {
      const def = LOCAL_TOOL_DEFINITIONS.find((d) => d.name === name)!;
      for (const key of Object.keys(def.inputSchema.properties)) expect(key).not.toMatch(/vies|verified|valid|check/i);
    }
  });

  it("R3: a VIES-looking argument is ignored — the stored result comes from VIES only", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-ai-vies"));
    const c = await create_customer(db, { ...AT, vies: { status: "valid" }, vies_status: "valid" } as any, withVies(ctx, stubVies({ ATU12345678: "not_checked" })));
    expect(c.vies?.status).toBe("not_checked");
  });
});

describe("R2: tax data has its own tool", () => {
  it("update_customer refuses every tax field, nothing saved", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-tax-refuse"));
    const c = await create_customer(db, AT, withVies(ctx));
    for (const field of ["name", "address_lines", "country", "uid"]) {
      await expect(update_customer(db, { id: c.id, revision: 1, email: "x@y.example", [field]: (AT as any)[field] }, withVies(ctx))).rejects.toThrow(
        "Refused: name/address/country/VAT ID are tax data — use update_customer_tax_data. Nothing was saved."
      );
    }
    expect((await get_customer(db, { id: c.id })).revision).toBe(1);
  });

  it("update_customer's schema has no tax field; update_customer_tax_data requires all four", () => {
    const upd = LOCAL_TOOL_DEFINITIONS.find((d) => d.name === "update_customer")!;
    for (const f of ["name", "address_lines", "country", "uid"]) expect(upd.inputSchema.properties).not.toHaveProperty(f);
    const tax = LOCAL_TOOL_DEFINITIONS.find((d) => d.name === "update_customer_tax_data")!;
    expect(tax.inputSchema.required).toEqual(expect.arrayContaining(["id", "revision", "name", "address_lines", "country", "uid"]));
  });

  it("update_customer_tax_data refuses a partial replacement", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-tax-partial"));
    const c = await create_customer(db, AT, withVies(ctx));
    await expect(update_customer_tax_data(db, { id: c.id, revision: 1, name: "X", address_lines: ["a"], country: "AT" }, withVies(ctx))).rejects.toThrow(
      /uid required.*Nothing was saved/
    );
  });

  it("R9: customer data is written only by the three customer write tools, each carrying ticket_id", () => {
    const writes = LOCAL_TOOL_DEFINITIONS.filter((d) => /customer/.test(d.name) && "ticket_id" in d.inputSchema.properties).map((d) => d.name);
    expect(writes).toEqual(["create_customer", "update_customer", "update_customer_tax_data"]);
  });
});

describe("R11: revision rule", () => {
  it("each change makes the next revision; stale revision refused naming both; old revision readable", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-rev"));
    const c = await create_customer(db, { ...AT, email: "old@x.example" }, withVies(ctx));
    const r2 = await update_customer(db, { id: c.id, revision: 1, email: "new@x.example", ticket_id: "t-2" }, withVies(ctx));
    expect(r2).toMatchObject({ revision: 2, email: "new@x.example" });
    const NEW = { name: "Drautal AG", address_lines: ["Bahnhofstraße 1", "9500 Villach"], country: "AT", uid: "ATU87654321" };
    const r3 = await update_customer_tax_data(db, { id: c.id, revision: 2, ...NEW, ticket_id: "t-3" }, withVies(ctx));
    expect(r3).toMatchObject({ ...NEW, revision: 3, email: "new@x.example" });

    await expect(update_customer(db, { id: c.id, revision: 2, email: "z@x.example" }, withVies(ctx))).rejects.toThrow(
      `Refused: Customer ${c.id} is at revision 3; this request is for revision 2. Nothing was saved.`
    );
    await expect(update_customer_tax_data(db, { id: c.id, revision: 1, ...AT }, withVies(ctx))).rejects.toThrow(
      `Refused: Customer ${c.id} is at revision 3; this request is for revision 1. Nothing was saved.`
    );
    expect((await get_customer(db, { id: c.id })).revision).toBe(3);

    expect(await get_customer(db, { id: c.id, revision: 1 })).toMatchObject({ ...AT, email: "old@x.example", revision: 1, vies: null });
    expect(await get_customer(db, { id: c.id, revision: 2 })).toMatchObject({ ...AT, email: "new@x.example", revision: 2 });
    const revs = await revisions(c.id);
    expect(revs.map((r) => [r.revision, r.ticket_id])).toEqual([[1, null], [2, "t-2"], [3, "t-3"]]);
    for (const r of revs) expect(Object.keys(JSON.parse(r.content)).sort()).toEqual(["address_lines", "country", "crm_contact_id", "email", "name", "uid"]);
    await expect(get_customer(db, { id: c.id, revision: 9 })).rejects.toThrow(/has no revision 9 \(current: 3\)/);
  });

  it("a change tool without revision is refused", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-norev"));
    const c = await create_customer(db, AT, withVies(ctx));
    await expect(update_customer(db, { id: c.id, email: "x@y.example" }, withVies(ctx))).rejects.toThrow(/revision is required/);
  });

  it("identical tax data is refused (a revision must mean a change)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-same"));
    const c = await create_customer(db, AT, withVies(ctx));
    await expect(update_customer_tax_data(db, { id: c.id, revision: 1, ...AT, uid: "ATU 1234 5678" }, withVies(ctx))).rejects.toThrow(
      /nothing would change.*Nothing was saved/
    );
    await expect(update_customer(db, { id: c.id, revision: 1, email: null }, withVies(ctx))).rejects.toThrow(/nothing would change/);
  });

  it("…except the same EU VAT ID not yet confirmed: that re-runs VIES (the way to 'confirm the VAT ID first', D1)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-recheck"));
    const c = await create_customer(db, AT, withVies(ctx, stubVies({ ATU12345678: "not_checked" })));
    const again = await update_customer_tax_data(db, { id: c.id, revision: 1, ...AT }, withVies(ctx));
    expect(again).toMatchObject({ revision: 2, vies: { status: "valid" } });
    await expect(update_customer_tax_data(db, { id: c.id, revision: 2, ...AT }, withVies(ctx))).rejects.toThrow(/nothing would change/);
  });

  it("CLI customers keep working: revision 1, no VIES (null = never checked)", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-cli"));
    const c = await addCustomer(db, AT);
    expect(c).toMatchObject({ revision: 1, vies: null });
    expect(await revisions(c.id)).toHaveLength(1);
    const u = await update_customer(db, { id: c.id, revision: 1, crm_contact_id: "crm-9" }, withVies(ctx));
    expect(u).toMatchObject({ revision: 2, crm_contact_id: "crm-9" });
  });
});

describe("R10: CRM → ERP convert is idempotent", () => {
  it("a second create_customer for the same crm_contact_id is refused naming the first", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-idem-crm"));
    const first = await create_customer(db, { ...AT, uid: undefined, crm_contact_id: "crm-42" }, withVies(ctx));
    await expect(create_customer(db, { ...AT, uid: undefined, name: "Other", crm_contact_id: "crm-42" }, withVies(ctx))).rejects.toThrow(
      `Refused: customer ${first.id} already has CRM contact crm-42. Nothing was saved.`
    );
    expect(await find_customers(db, {})).toHaveLength(1);
    expect((await find_customers(db, { crm_contact_id: "crm-42" }))[0].id).toBe(first.id);
  });

  it("a second create_customer for the same VAT ID (any spelling) is refused naming the first — before VIES is asked", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-idem-uid"));
    const first = await create_customer(db, AT, withVies(ctx));
    const calls: any[] = [];
    await expect(create_customer(db, { ...AT, name: "Other", uid: "atu-12345678" }, withVies(ctx, stubVies({}, calls)))).rejects.toThrow(
      `Refused: customer ${first.id} already has VAT ID ATU12345678. Nothing was saved.`
    );
    expect(calls).toEqual([]);
    expect(await find_customers(db, {})).toHaveLength(1);
    expect((await find_customers(db, { uid: "ATU 123 456 78" }))[0].id).toBe(first.id);
  });

  it("update_customer / update_customer_tax_data cannot take another customer's CRM contact or VAT ID", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-idem-update"));
    const a = await create_customer(db, { ...AT, crm_contact_id: "crm-a" }, withVies(ctx));
    const b = await create_customer(db, { name: "B GmbH", address_lines: ["x"], country: "AT" }, withVies(ctx));
    await expect(update_customer(db, { id: b.id, revision: 1, crm_contact_id: "crm-a" }, withVies(ctx))).rejects.toThrow(
      `customer ${a.id} already has CRM contact crm-a`
    );
    await expect(update_customer_tax_data(db, { id: b.id, revision: 1, name: "B GmbH", address_lines: ["x"], country: "AT", uid: "ATU12345678" }, withVies(ctx))).rejects.toThrow(
      `customer ${a.id} already has VAT ID ATU12345678`
    );
    expect((await get_customer(db, { id: b.id })).revision).toBe(1);
  });

  it("the CLI refuses duplicates too", async () => {
    ({ db, ctx, dataDir } = await freshLocalCtx("cw-idem-cli"));
    const a = await addCustomer(db, AT);
    await expect(addCustomer(db, { ...AT, name: "Dup" })).rejects.toThrow(`customer ${a.id} already has VAT ID ATU12345678`);
  });
});
