/**
 * Local quotes (Part B, docs/local-production-contract.md §4) — empty until
 * Part B lands. Handlers keyed by tool name, merged by dispatch.ts.
 */
import type { LocalToolHandler } from "../dispatch.js";

export const QUOTE_TOOL_HANDLERS: Readonly<Record<string, LocalToolHandler>> = {};
