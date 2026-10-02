/**
 * How to build a good simulation package — the how-to part of load_simulation's
 * description. Byte-identical in hap-erp-mcp, hap-crm-mcp and hap-email-mcp, like
 * simulation-package-schema.ts. Tool documentation only: vendor-neutral, no
 * product or governance terms (a test enforces that), so the connector works the
 * same behind any gateway or AI client.
 */
export const SIMULATION_PACKAGE_GUIDE =
  "How to build a good package: start from real cases the company's people actually handled " +
  "(an email, or a short written note of a phone call) together with the reply they sent. " +
  "Ask the people for what a case does not show — stock, price, credit and open balance at the time, " +
  "and why something was refused. Replace every name, address, phone number, email address and " +
  "customer or order number with invented ones, and keep them consistent across cases; have a person " +
  "check the renamed cases before loading. Describe products and customers exactly as the cases need " +
  "them — a case about an item being out of stock needs that item with stock 0. Build one package and " +
  "load the same package into each simulator.";
