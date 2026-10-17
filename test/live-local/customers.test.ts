import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db.js";
import { addCustomer, importCustomers, find_customers } from "../../src/live/local/tools/customers.js";
import { freshLocalCtx, cleanupDataDir } from "./fixtures.js";

let db: Db;
let dataDir: string;

afterEach(async () => {
  if (db) await db.close();
  if (dataDir) cleanupDataDir(dataDir);
});

describe("addCustomer (CLI-only — the AI has no tool to call this)", () => {
  it("adds a customer with a generated id when none is given", async () => {
    ({ db, dataDir } = await freshLocalCtx("customers-add"));
    const c = await addCustomer(db, { name: "Test GmbH", address_lines: ["Street 1", "1010 Wien"], country: "at", uid: "ATU1", email: "a@b.com" });
    expect(c.id).toBeTruthy();
    expect(c.country).toBe("AT"); // uppercased
  });

  it("refuses an address_lines that is empty", async () => {
    ({ db, dataDir } = await freshLocalCtx("customers-add-bad-addr"));
    await expect(addCustomer(db, { name: "X", address_lines: [], country: "AT" })).rejects.toThrow(/address_lines/);
  });

  it("refuses a non-2-letter country code", async () => {
    ({ db, dataDir } = await freshLocalCtx("customers-add-bad-country"));
    await expect(addCustomer(db, { name: "X", address_lines: ["a"], country: "Austria" })).rejects.toThrow(/country/);
  });
});

describe("importCustomers — all-or-nothing", () => {
  it("imports every valid entry", async () => {
    ({ db, dataDir } = await freshLocalCtx("customers-import-ok"));
    const created = await importCustomers(db, [
      { name: "A GmbH", address_lines: ["x"], country: "AT" },
      { name: "B GmbH", address_lines: ["y"], country: "DE", uid: "DE1" },
    ]);
    expect(created).toHaveLength(2);
    expect(await find_customers(db, {})).toHaveLength(2);
  });

  it("saves nothing if any entry is invalid", async () => {
    ({ db, dataDir } = await freshLocalCtx("customers-import-bad"));
    await expect(
      importCustomers(db, [{ name: "A GmbH", address_lines: ["x"], country: "AT" }, { name: "", address_lines: ["y"], country: "DE" }])
    ).rejects.toThrow(/name is required/);
    expect(await find_customers(db, {})).toHaveLength(0);
  });

  it("saves nothing if two entries declare the same id", async () => {
    ({ db, dataDir } = await freshLocalCtx("customers-import-dup-id"));
    await expect(
      importCustomers(db, [
        { id: "c1", name: "A GmbH", address_lines: ["x"], country: "AT" },
        { id: "c1", name: "B GmbH", address_lines: ["y"], country: "AT" },
      ])
    ).rejects.toThrow(/appears twice/);
    expect(await find_customers(db, {})).toHaveLength(0);
  });
});
