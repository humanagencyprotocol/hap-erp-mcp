/**
 * Tool documentation stays vendor-neutral: an MCP server describes its own tools
 * and works the same behind any gateway or AI client, so nothing an agent reads
 * here may name a product or a governance concept (decision 2026-10-02 — those
 * belong to the gateway's manifest and the person's mandate, not the connector).
 * load_simulation carries the shared how-to for building a package.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import { SIMULATION_PACKAGE_GUIDE } from "../src/simulation-package-guide.js";

describe("tool documentation", () => {
  const text = JSON.stringify(TOOL_DEFINITIONS);

  it("names no product or governance concept", () => {
    for (const term of [/suveren/i, /mandate/i, /three-week/i, /\bticket/i]) expect(text).not.toMatch(term);
  });

  it("load_simulation carries the how-to for building a package", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "load_simulation")!;
    expect(tool.description).toContain(SIMULATION_PACKAGE_GUIDE);
    expect(SIMULATION_PACKAGE_GUIDE).toMatch(/real cases/);
    expect(SIMULATION_PACKAGE_GUIDE).toMatch(/person check/);
  });
});
