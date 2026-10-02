/**
 * The format description the agent sees (load_simulation's `package` JSON Schema)
 * and this connector's own parser must agree: what the schema calls valid the
 * parser loads, and what it calls invalid the parser refuses. Otherwise an agent
 * following the description builds packages the connector rejects — or the
 * description promises checks nobody makes. The schema file is byte-identical in
 * all three simulators; hap-e2e compares the published tool schemas.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import Ajv from "ajv";
import { SIMULATION_PACKAGE_SCHEMA } from "../src/simulation-package-schema.js";
import { parseSimulationPackage } from "../src/company.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(SIMULATION_PACKAGE_SCHEMA as object);
const example = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(example));

describe("format description (JSON Schema) and parser agree", () => {
  it("the shipped example package is valid for both", () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(() => parseSimulationPackage(example)).not.toThrow();
  });

  const broken: Array<[string, (p: any) => void]> = [
    ["fractional stock", (p) => { p.products[0].stock = 1.5; }],
    ["no products", (p) => { p.products = []; }],
    ["a customer without credit_limit", (p) => { delete p.customers[0].credit_limit; }],
    ["a bad currency", (p) => { p.currency = "euro"; }],
    ["a negative list price", (p) => { p.products[0].list_price = -1; }],
  ];
  it.each(broken)("both refuse a package with %s", (_label, breakIt) => {
    const p = clone();
    breakIt(p);
    expect(validate(p)).toBe(false);
    expect(() => parseSimulationPackage(p)).toThrow();
  });
});
