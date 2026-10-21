/**
 * Local catalogue items (Part C, docs/local-production-contract.md §5) —
 * empty until Part C lands. Handlers keyed by tool name, merged by dispatch.ts.
 */
import type { LocalToolHandler } from "../dispatch.js";

export const ITEM_TOOL_HANDLERS: Readonly<Record<string, LocalToolHandler>> = {};
