/**
 * Builds the variables tree (see temp/invoice-template/VARIABLES.md) the
 * template engine substitutes against, from the company file, the customer
 * record, the request, and the computed totals. Date-shaped variables are
 * pre-formatted here (DD.MM.YYYY) because the shipped template references
 * them with no `|date` filter (e.g. `{{dokument.datum}}`) — money-shaped
 * variables are left as raw numbers because the template always applies
 * `|money` explicitly.
 */
import { formatDate } from "./template-engine.js";
import { addressOneLine, type LiveCompany } from "./company-file.js";
import type { PricedInvoiceLine } from "../../money.js";
import type { TaxMode } from "./tax.js";

export interface LineForTemplate extends PricedInvoiceLine {
  unit: string;
}

export interface BuildViewModelInput {
  company: LiveCompany;
  customer: { name: string; addressLines: string[]; uid: string | null };
  documentKind: "invoice" | "credit_note";
  number: string;
  issuedAt: Date;
  servicePeriod: { from: string; to: string };
  lines: LineForTemplate[];
  netTotal: number;
  vatTotal: number;
  grossTotal: number;
  taxMode: TaxMode;
  /** Representative VAT rate shown on the totals line when taxMode is "normal". */
  vatRate: number;
  /** Required for dokument.art == "invoice". */
  invoiceOnly?: { paymentTermDays: number; dueDate: Date };
  /** Required for dokument.art == "credit_note". */
  creditNoteOnly?: { invoiceNumber: string; invoiceIssuedAt: Date };
}

export function buildViewModel(input: BuildViewModelInput): Record<string, unknown> {
  const { company, customer, documentKind, lines } = input;
  const isCreditNote = documentKind === "credit_note";
  // The signed-off samples show credit-note totals as negative (a reduction)
  // while each line stays positive (what the line itself is worth) — see
  // temp/invoice-sample/muster-gutschrift-storno.html.
  const sign = isCreditNote ? -1 : 1;

  return {
    dokument: {
      art: documentKind,
      nummer: input.number,
      datum: formatDate(input.issuedAt),
    },
    rechnung: isCreditNote
      ? undefined
      : {
          nummer: input.number,
          zahlungsziel_tage: input.invoiceOnly!.paymentTermDays,
          faellig: formatDate(input.invoiceOnly!.dueDate),
        },
    leistung: {
      zeitraum: `${formatDate(input.servicePeriod.from)} – ${formatDate(input.servicePeriod.to)}`,
      // A one-day service reads as a date ("Leistungsdatum"), not a range from
      // a day to the same day — the template chooses via `when`.
      datum: formatDate(input.servicePeriod.from),
      ein_tag: input.servicePeriod.from === input.servicePeriod.to,
    },
    kunde: {
      name: customer.name,
      adresse: { mehrzeilig: [customer.name, ...customer.addressLines].join("\n") },
      uid: customer.uid,
      land: null,
    },
    positionen: lines.map((l, i) => ({
      nr: i + 1,
      beschreibung: l.description,
      menge: l.qty,
      einheit: l.unit,
      einzelpreis: l.unit_price,
      gesamt: l.line_net,
    })),
    summe: {
      netto: sign * input.netTotal,
      ust: sign * input.vatTotal,
      brutto: sign * input.grossTotal,
    },
    steuer: { art: input.taxMode, satz: input.vatRate },
    gutschrift: isCreditNote
      ? {
          zu_rechnung: {
            nummer: input.creditNoteOnly!.invoiceNumber,
            datum: formatDate(input.creditNoteOnly!.invoiceIssuedAt),
          },
        }
      : undefined,
    zahlung: { link: null }, // never populated in the PDF — payment link is email-only (decision 2026-10-17)
    firma: {
      name: company.name,
      inhaber: company.owner,
      adresse: { einzeilig: addressOneLine(company.address) },
      uid: company.uid,
      email: company.email,
      web: company.web,
      register: company.register ?? "",
      bank: { name: company.bank.name, iban: company.bank.iban, bic: company.bank.bic },
    },
  };
}
