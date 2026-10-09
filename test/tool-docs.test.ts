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
    // ticket_id is exempt: it is the HAP v0.7 wire argument name (mandated by
    // the protocol, same treatment the old receipt_id key got) — not prose
    // explaining the gateway's ticket concept to the agent.
    for (const term of [/suveren/i, /mandate/i, /three-week/i, /\bticket(?!_id)/i]) expect(text).not.toMatch(term);
  });

  it("load_simulation carries the how-to for building a package", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "load_simulation")!;
    expect(tool.description).toContain(SIMULATION_PACKAGE_GUIDE);
    expect(SIMULATION_PACKAGE_GUIDE).toMatch(/real cases/);
    expect(SIMULATION_PACKAGE_GUIDE).toMatch(/person check/);
  });

  it("declares ticket_id, not receipt_id, on every write tool's input schema (v0.7 wire rename)", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).not.toHaveProperty("receipt_id");
    }
    const writeTools = ["create_quote", "update_quote", "send_quote", "convert_quote_to_order", "load_simulation", "clear_simulation"];
    for (const name of writeTools) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).toHaveProperty("ticket_id");
    }
  });
});
