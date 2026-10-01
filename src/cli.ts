/**
 * Local operator commands. Deliberately NOT MCP tools: the agent under test must
 * be able neither to read nor to change the record its work is measured by.
 *
 *   erp-mcp export                 everything needed to line up trigger → ticket → effect
 *   erp-mcp scenario next <file>   hand over the next request, record when
 *   erp-mcp scenario status <file> which requests were handed over, which are pending
 */
import { readFileSync } from "fs";
import { createDb, type Db } from "./db.js";
import { getMode } from "./mode.js";

export interface ScenarioRequest {
  id: string;
  request: string;
  /** What a correct outcome looks like, e.g. { customer_id, lines, value }. Free-form, carried into the export. */
  expected?: unknown;
}

export function loadScenario(path: string): ScenarioRequest[] {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Scenario file ${path} cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const list = raw?.requests;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`Scenario file ${path}: \`requests\` must be a non-empty list`);
  const ids = new Set<string>();
  return list.map((r: any, i: number) => {
    if (typeof r?.id !== "string" || !r.id.trim()) throw new Error(`Scenario file ${path}: requests[${i}].id is required`);
    if (ids.has(r.id)) throw new Error(`Scenario file ${path}: request id ${JSON.stringify(r.id)} appears twice`);
    ids.add(r.id);
    if (typeof r.request !== "string" || !r.request.trim()) throw new Error(`Scenario file ${path}: requests[${i}].request is required`);
    return { id: r.id, request: r.request, expected: r.expected };
  });
}

/** Records the hand-over time of the first request not yet handed over. Null when all are done. */
export async function nextRequest(db: Db, scenario: ScenarioRequest[]): Promise<(ScenarioRequest & { triggered_at: string }) | null> {
  const done = new Set((await db.all<{ scenario_id: string }>(`SELECT scenario_id FROM triggers`)).map((r) => r.scenario_id));
  const next = scenario.find((r) => !done.has(r.id));
  if (!next) return null;
  await db.run(`INSERT INTO triggers (scenario_id, request, expected) VALUES (?, ?, ?)`, [
    next.id, next.request, next.expected === undefined ? null : JSON.stringify(next.expected),
  ]);
  const row = await db.get<{ triggered_at: string }>(`SELECT triggered_at FROM triggers WHERE scenario_id = ?`, [next.id]);
  return { ...next, triggered_at: row!.triggered_at };
}

export async function exportRecord(db: Db, mode = getMode()) {
  const quotes = await db.all<any>(`SELECT * FROM quotes ORDER BY created_at, number`);
  const lines = await db.all<any>(`SELECT * FROM quote_lines`);
  const byQuote = new Map<string, any[]>();
  for (const l of lines) byQuote.set(l.quote_id, [...(byQuote.get(l.quote_id) ?? []), l]);
  return {
    mode,
    exported_at: new Date().toISOString(),
    triggers: (await db.all<any>(`SELECT * FROM triggers ORDER BY triggered_at`)).map((t) => ({
      ...t, expected: t.expected ? JSON.parse(t.expected) : null,
    })),
    quotes: quotes.map((q) => ({ ...q, lines: byQuote.get(q.id) ?? [] })),
    orders: await db.all<any>(`SELECT * FROM orders ORDER BY created_at, number`),
    refusals: await db.all<any>(`SELECT * FROM refusals ORDER BY at`),
  };
}

const USAGE = `usage: erp-mcp export | erp-mcp scenario next <file> | erp-mcp scenario status <file>`;

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, sub, file] = argv;
  try {
    if (cmd === "export") {
      const db = await createDb();
      process.stdout.write(JSON.stringify(await exportRecord(db), null, 2) + "\n");
      await db.close();
      return 0;
    }
    if (cmd === "scenario" && (sub === "next" || sub === "status") && file) {
      const scenario = loadScenario(file);
      const db = await createDb();
      if (sub === "next") {
        const next = await nextRequest(db, scenario);
        process.stdout.write(next ? `[${next.id}] handed over ${next.triggered_at} UTC\n${next.request}\n` : "All requests handed over.\n");
      } else {
        const done = new Map((await db.all<any>(`SELECT scenario_id, triggered_at FROM triggers`)).map((r) => [r.scenario_id, r.triggered_at]));
        for (const r of scenario) process.stdout.write(`${r.id}\t${done.get(r.id) ?? "pending"}\t${r.request}\n`);
      }
      await db.close();
      return 0;
    }
    process.stderr.write(USAGE + "\n");
    return 2;
  } catch (err) {
    process.stderr.write(`[erp-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
