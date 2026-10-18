/**
 * Loads and minimally validates an invoice template (declarative JSON: page
 * settings, texts, blocks). The template carries its own language and
 * layout; this connector ships `rechnung-de` v1 as the default. No code runs
 * from a template — see template-engine.ts for the fixed, small set of
 * operations (`{{variable}}` substitution, `|money`/`|date` filters, `when`
 * comparisons) the renderer supports against it.
 */
import { expandHome } from "./paths.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface InvoiceTemplate {
  template: string;
  version: string;
  language: string;
  documents: string[];
  page: { size: string; margins_mm: [number, number, number, number]; font: string; font_size: number };
  texts: Record<string, string>;
  blocks: unknown[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from `startDir` to the nearest directory containing a
 * `package.json` — the package root. Needed because this module's own
 * directory depth relative to the package root differs between a test run
 * (unbundled, src/live/local — three levels down) and the built CLI
 * (tsup bundles everything into one dist/index.js — one level down): a
 * single fixed `../..` would be right for only one of the two.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate package root above ${startDir}`);
}

/** Bundled default — the repo's own copy of the signed-off `rechnung-de.v1.json` draft. */
export const DEFAULT_TEMPLATE_PATH = join(findPackageRoot(__dirname), "templates", "rechnung-de.v1.json");

function fail(path: string, msg: string): never {
  throw new Error(`Invoice template ${path}: ${msg}`);
}

export function parseTemplate(raw: unknown, path = "(inline)"): InvoiceTemplate {
  if (!raw || typeof raw !== "object") fail(path, "must be a JSON object");
  const t = raw as Record<string, unknown>;
  if (typeof t.template !== "string" || !t.template.trim()) fail(path, "`template` (id) is required");
  if (typeof t.version !== "string" || !t.version.trim()) fail(path, "`version` is required");
  if (typeof t.language !== "string" || !t.language.trim()) fail(path, "`language` is required");
  if (!Array.isArray(t.documents) || t.documents.length === 0) fail(path, "`documents` must be a non-empty list");
  if (!t.page || typeof t.page !== "object") fail(path, "`page` is required");
  if (!t.texts || typeof t.texts !== "object") fail(path, "`texts` is required");
  if (!Array.isArray(t.blocks) || t.blocks.length === 0) fail(path, "`blocks` must be a non-empty list");
  return t as unknown as InvoiceTemplate;
}

export function loadTemplateFile(path: string): InvoiceTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path, `cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseTemplate(raw, path);
}

/** Resolves ERP_INVOICE_TEMPLATE, falling back to the bundled default. */
export function resolveTemplate(env: NodeJS.ProcessEnv = process.env): { template: InvoiceTemplate; path: string } {
  const configured = env.ERP_INVOICE_TEMPLATE?.trim();
  const path = configured ? expandHome(configured) : DEFAULT_TEMPLATE_PATH;
  return { template: loadTemplateFile(path), path };
}

export function requireDocumentSupported(template: InvoiceTemplate, kind: "invoice" | "credit_note"): void {
  if (!template.documents.includes(kind)) {
    throw new Error(`Refused: template "${template.template}" v${template.version} does not support document kind "${kind}".`);
  }
}
