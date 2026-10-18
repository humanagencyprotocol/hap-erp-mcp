/**
 * Renders a resolved invoice/credit-note to a PDF buffer from a declarative
 * template + its variables tree. Pure JS — pdfmake (built on pdfkit), no
 * browser, no headless Chrome. The renderer knows a fixed, small vocabulary
 * of block TYPES (letterhead, sender_line, address_and_meta, heading,
 * paragraph, lines_table, totals, note, footer); everything else — which
 * blocks appear, their texts, their conditions — comes from the template.
 * No code runs from a template.
 *
 * Deterministic by construction (Andreas, 2026-10-18): CreationDate/ModDate
 * are set to the document's own `document_date` (never "now" — see
 * tools/invoices.ts and date.ts), `compress: false` avoids zlib as a source
 * of variance, and only the standard (non-embedded) Helvetica family is used,
 * so pdfkit never generates a random font-subset tag. pdfkit's file ID
 * (`/ID`) is itself a hash of `info` — including CreationDate — so it too is
 * fixed for the same inputs; pdfkit only reaches for real randomness
 * (`crypto.getRandomValues`) when encrypting with a password, which this
 * connector never does. Net effect: the same template + vars + issuedAt
 * render to byte-identical PDF bytes every time — this is what lets
 * preview_invoice's sha256 equal the archived document's sha256 for the same
 * request issued the same day, and lets the gateway re-check an approved
 * preview against what create_invoice is about to produce.
 */
import pdfMakeModule from "pdfmake";
import type { InvoiceTemplate } from "./template.js";
import { get, substitute, resolveText, evalWhen } from "./template-engine.js";

// pdfmake's ESM default export shape varies by how it's bundled; normalize.
const pdfMake: any = (pdfMakeModule as any).default ?? pdfMakeModule;

const MM_TO_PT = 2.8346456693;

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  pdfMake.setLocalAccessPolicy(() => true); // we only ever reference built-in standard font names, never user paths
  pdfMake.setUrlAccessPolicy(() => false); // never fetch remote resources
  pdfMake.setFonts({
    Helvetica: {
      normal: "Helvetica",
      bold: "Helvetica-Bold",
      italics: "Helvetica-Oblique",
      bolditalics: "Helvetica-BoldOblique",
    },
  });
  configured = true;
}

const GRAY = "#555555";
const BLACK = "#111111";
const LIGHT = "#dddddd";

type Row = { label: string; value: string; strong: boolean };

/** Normalizes a meta/totals row entry: a plain [label, value] tuple, or `{ when, row, strong }`. */
function normalizeRows(
  entries: unknown[],
  vars: Record<string, unknown>,
  texts: Record<string, string>
): Row[] {
  const out: Row[] = [];
  for (const entry of entries) {
    let rowTuple: [string, string];
    let strong = false;
    if (Array.isArray(entry)) {
      rowTuple = entry as [string, string];
    } else {
      const e = entry as { when?: string; row: [string, string]; strong?: boolean };
      if (e.when && !evalWhen(e.when, vars)) continue;
      rowTuple = e.row;
      strong = !!e.strong;
    }
    out.push({ label: resolveText(rowTuple[0], vars, texts), value: substitute(rowTuple[1], vars), strong });
  }
  return out;
}

function renderLetterhead(block: any, vars: Record<string, unknown>) {
  const left: string[] = block.left ?? [];
  const right: string[] = block.right ?? [];
  return {
    columns: [
      {
        width: "*",
        stack: left.map((t, i) => ({
          text: substitute(t, vars),
          bold: i === 0,
          fontSize: i === 0 ? 16 : 8,
          color: i === 0 ? BLACK : GRAY,
          margin: [0, i === 0 ? 0 : 2, 0, 0],
        })),
      },
      {
        width: "auto",
        alignment: "right",
        stack: right.map((t) => ({ text: substitute(t, vars), fontSize: 8, color: GRAY })),
      },
    ],
  };
}

function renderSenderLine(block: any, vars: Record<string, unknown>) {
  return {
    stack: [
      { text: substitute(block.text, vars), fontSize: 7.5, color: GRAY, margin: [0, 14, 0, 1] },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 240, y2: 0, lineWidth: 0.75, lineColor: "#999999" }], margin: [0, 0, 0, 4] },
    ],
  };
}

function renderAddressAndMeta(block: any, vars: Record<string, unknown>, texts: Record<string, string>) {
  const addressText = substitute(block.address, vars);
  const addressLines = addressText.split("\n").map((line) => ({ text: line }));
  const metaRows = normalizeRows(block.meta ?? [], vars, texts);
  return {
    columns: [
      { width: "*", stack: addressLines, margin: [0, 6, 0, 0] },
      {
        width: "auto",
        table: {
          body: metaRows.map((r) => [
            { text: r.label, color: GRAY, border: [false, false, false, false] },
            { text: r.value, bold: r.label === undefined ? false : false, border: [false, false, false, false] },
          ]),
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: (i: number) => (i === 0 ? 0 : 6),
          paddingRight: () => 0,
          paddingTop: () => 1,
          paddingBottom: () => 1,
        },
      },
    ],
  };
}

function renderHeading(block: any, vars: Record<string, unknown>, texts: Record<string, string>) {
  return { text: resolveText(block.text, vars, texts), fontSize: 14, bold: true, margin: [0, 10, 0, 4] };
}

function renderParagraph(block: any, vars: Record<string, unknown>, texts: Record<string, string>) {
  return { text: resolveText(block.text, vars, texts), margin: [0, 2, 0, 2] };
}

function renderLinesTable(block: any, vars: Record<string, unknown>, texts: Record<string, string>) {
  const rowsPath: string = block.rows;
  const items = (get(vars, rowsPath) as Record<string, unknown>[]) ?? [];
  const columns: Array<{ head: string; value: string; width?: string; align?: string }> = block.columns;

  const header = columns.map((c) => ({
    text: resolveText(c.head, vars, texts),
    bold: true,
    fontSize: 9,
    alignment: c.align ?? "left",
  }));
  const body = items.map((item) => {
    const scope = { ...vars, pos: item };
    return columns.map((c) => ({ text: substitute(c.value, scope), alignment: c.align ?? "left" }));
  });

  return {
    table: {
      headerRows: 1,
      widths: columns.map((c) => c.width ?? "auto"),
      body: [header, ...body],
    },
    layout: {
      hLineWidth: (i: number) => (i === 1 ? 1.2 : i === 0 ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i === 1 ? BLACK : LIGHT),
      paddingLeft: () => 2,
      paddingRight: () => 2,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    margin: [0, 4, 0, 0],
  };
}

function renderTotals(block: any, vars: Record<string, unknown>, texts: Record<string, string>) {
  const rows = normalizeRows(block.rows ?? [], vars, texts);
  const body = rows.map((r) => [
    { text: r.label, bold: r.strong },
    { text: r.value, bold: r.strong, alignment: "right" },
  ]);
  return {
    table: { widths: ["*", "auto"], body },
    layout: {
      hLineWidth: (i: number, node: any) => (i === node.table.body.length - 1 ? 1.2 : 0),
      vLineWidth: () => 0,
      hLineColor: () => BLACK,
      paddingLeft: () => 2,
      paddingRight: () => 2,
      paddingTop: () => 1,
      paddingBottom: () => 1,
    },
    alignment: "right",
    margin: [140, 4, 0, 0],
  };
}

function renderNote(block: any, vars: Record<string, unknown>, texts: Record<string, string>) {
  const text = resolveText(block.text, vars, texts);
  if (!block.framed) return { text, margin: [0, 4, 0, 0] };
  return {
    table: { widths: ["*"], body: [[{ text, border: [true, true, true, true] }]] },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => BLACK,
      vLineColor: () => BLACK,
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 6,
      paddingBottom: () => 6,
    },
    margin: [0, 6, 0, 0],
  };
}

function buildFooter(block: any | undefined, vars: Record<string, unknown>, marginsPt: [number, number, number, number]) {
  if (!block) return undefined;
  const columns: string[][] = block.columns;
  return () => ({
    columns: columns.map((lines) => ({
      stack: lines.map((t: string) => ({ text: substitute(t, vars), fontSize: 7.5, color: GRAY })),
    })),
    columnGap: 12,
    margin: [marginsPt[0], 2, marginsPt[2], 0],
    fontSize: 7.5,
  });
}

/**
 * Walks the template's blocks and resolves them (substitution + `when` +
 * filters) into a pdfmake content tree, without touching pdfmake itself.
 * Exported so tests can assert what a template condition actually produced
 * (e.g. "the reverse-charge note is present", "the credit note's content
 * mentions the invoice it corrects") against this resolved tree — a faithful
 * and much less brittle proxy than extracting text back out of PDF bytes,
 * since this tree IS what pdf-render then hands to pdfmake to draw.
 */
export function resolveTemplateBlocks(
  template: InvoiceTemplate,
  vars: Record<string, unknown>
): { content: unknown[]; footer: ReturnType<typeof buildFooter> } {
  const texts = template.texts;
  const content: unknown[] = [];
  let footerBlock: any | undefined;

  for (const raw of template.blocks) {
    const block = raw as any;
    if (block.when && !evalWhen(block.when, vars)) continue;
    switch (block.type) {
      case "letterhead":
        content.push(renderLetterhead(block, vars));
        break;
      case "sender_line":
        content.push(renderSenderLine(block, vars));
        break;
      case "address_and_meta":
        content.push(renderAddressAndMeta(block, vars, texts));
        break;
      case "heading":
        content.push(renderHeading(block, vars, texts));
        break;
      case "paragraph":
        content.push(renderParagraph(block, vars, texts));
        break;
      case "lines_table":
        content.push(renderLinesTable(block, vars, texts));
        break;
      case "totals":
        content.push(renderTotals(block, vars, texts));
        break;
      case "note":
        content.push(renderNote(block, vars, texts));
        break;
      case "footer":
        footerBlock = block;
        break;
      default:
        throw new Error(`Template: unknown block type "${block.type}"`);
    }
  }

  const [mTop, mRight, mBottom, mLeft] = template.page.margins_mm;
  const marginsPt: [number, number, number, number] = [
    mLeft * MM_TO_PT,
    mTop * MM_TO_PT,
    mRight * MM_TO_PT,
    mBottom * MM_TO_PT,
  ];
  return { content, footer: buildFooter(footerBlock, vars, marginsPt) };
}

export async function renderInvoiceDocument(
  template: InvoiceTemplate,
  vars: Record<string, unknown>,
  issuedAt: Date
): Promise<Buffer> {
  ensureConfigured();

  const { content, footer } = resolveTemplateBlocks(template, vars);

  // Fixed, non-"now" metadata — see module docstring.
  const creationDate = issuedAt;

  const [mTop, mRight, mBottom, mLeft] = template.page.margins_mm;
  const marginsPt: [number, number, number, number] = [
    mLeft * MM_TO_PT,
    mTop * MM_TO_PT,
    mRight * MM_TO_PT,
    mBottom * MM_TO_PT,
  ];

  const docDefinition = {
    pageSize: (template.page.size || "A4") as "A4",
    pageMargins: marginsPt,
    // Uncompressed: a 7-year-archived invoice should stay readable with the
    // simplest possible tooling, and it keeps the content stream plain text
    // for the sha256 fingerprint to mean something to a human inspecting it.
    compress: false,
    defaultStyle: { font: "Helvetica", fontSize: template.page.font_size || 10 },
    info: {
      title: `${substitute("{{dokument.art}}", vars)} ${substitute("{{dokument.nummer}}", vars)}`,
      creationDate,
      modDate: creationDate,
    },
    footer,
    content,
  };

  const pdfDoc = pdfMake.createPdf(docDefinition);
  return pdfDoc.getBuffer();
}
