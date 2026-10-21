/**
 * EU VAT-ID check against the European Commission's VIES service
 * (docs/local-production-contract.md §3.5). The ONLY outside call this
 * connector makes in Local mode.
 *
 * Endpoint (EU VIES REST API):
 *   POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
 *   body {countryCode, vatNumber, requesterMemberStateCode, requesterNumber}
 * `countryCode` is the VIES prefix (EL for Greece, XI for Northern Ireland),
 * `vatNumber` the part after it. The requester is the company's own VAT ID
 * (a qualified check — VIES then returns a consultation number,
 * `requestIdentifier`, stored as `request_id`).
 *
 * Data sent outside this computer: the customer's country + VAT ID and the
 * company's own VAT ID. Nothing else.
 *
 * Config (connector env):
 *   ERP_VIES_URL         endpoint (default above; tests point it at a local stub)
 *   ERP_VIES_TIMEOUT_MS  timeout for a check at execution (default 8000)
 *   ERP_VIES=off         no call; every check is `not_checked`
 *
 * Never throws for an outage: network error, timeout, HTTP ≥ 500 or a VIES
 * service error is `not_checked` with the reason — never `valid`.
 */

export const DEFAULT_VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
export const DEFAULT_VIES_TIMEOUT_MS = 8000;
/** check_vat_id (the card preview) stays below the gateway's 5 s preview-read timeout. */
export const PREVIEW_VIES_TIMEOUT_MS = 4000;

export type ViesStatus = "valid" | "invalid" | "not_checked" | "not_applicable";

export interface ViesResult {
  status: ViesStatus;
  reason: string | null;
  checked_at: string | null;
  request_id: string | null;
  name: string | null;
  address: string | null;
}

export interface ViesQuery {
  /** VIES prefix (EL, XI, AT, …). */
  countryCode: string;
  /** The VAT number without its prefix. */
  vatNumber: string;
  /** The company's own VAT ID (normalised, with prefix), or null. */
  requester: string | null;
  /** Upper bound for this one check; the client's own timeout applies when lower. */
  timeoutMs?: number;
}

export interface ViesClient {
  check(q: ViesQuery): Promise<ViesResult>;
}

const UNAVAILABLE_ERRORS = new Set([
  "MS_UNAVAILABLE", "SERVICE_UNAVAILABLE", "TIMEOUT", "MS_MAX_CONCURRENT_REQ", "GLOBAL_MAX_CONCURRENT_REQ",
]);

export function notChecked(reason: string, at: Date = new Date()): ViesResult {
  return { status: "not_checked", reason, checked_at: at.toISOString(), request_id: null, name: null, address: null };
}

export function notApplicable(): ViesResult {
  return { status: "not_applicable", reason: null, checked_at: null, request_id: null, name: null, address: null };
}

/** VIES writes "---" for a name/address it does not disclose. */
function disclosed(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t !== "---" ? t : null;
}

type Log = (msg: string) => void;

/** Maps one VIES response body (HTTP < 500) to a result. Exported for tests. */
export function mapViesResponse(body: any, at: Date, log: Log = () => {}): ViesResult {
  const errorCode: string | undefined =
    (Array.isArray(body?.errorWrappers) && body.errorWrappers[0]?.error) ||
    (typeof body?.userError === "string" && !["VALID", "INVALID"].includes(body.userError) ? body.userError : undefined);
  if (errorCode && UNAVAILABLE_ERRORS.has(errorCode)) return notChecked(`VIES unavailable (${errorCode})`, at);
  if (errorCode === "INVALID_INPUT") {
    // Our offline format check let it through, VIES did not — the format table is wrong.
    log(`VIES rejected the input as malformed (INVALID_INPUT) — check the VAT-ID pattern table in vat-id.ts.`);
    return { status: "invalid", reason: "VIES: invalid input", checked_at: at.toISOString(), request_id: null, name: null, address: null };
  }
  if (errorCode) return notChecked(`VIES error (${errorCode})`, at);
  if (body?.valid === true) {
    return {
      status: "valid", reason: null, checked_at: at.toISOString(),
      request_id: typeof body.requestIdentifier === "string" && body.requestIdentifier ? body.requestIdentifier : null,
      name: disclosed(body.name), address: disclosed(body.address),
    };
  }
  if (body?.valid === false) {
    return { status: "invalid", reason: null, checked_at: at.toISOString(), request_id: null, name: null, address: null };
  }
  return notChecked("VIES answered without a result", at);
}

export interface HttpViesClientOptions {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: Log;
}

/** The real client: one HTTP POST per check, no caching. */
export function httpViesClient(opts: HttpViesClientOptions = {}): ViesClient {
  const url = opts.url ?? DEFAULT_VIES_URL;
  const clientTimeout = opts.timeoutMs ?? DEFAULT_VIES_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.error(`[erp-mcp] ${m}`));

  async function once(q: ViesQuery, requester: string | null, timeoutMs: number): Promise<{ result: ViesResult; requesterRefused: boolean }> {
    const body: Record<string, string> = { countryCode: q.countryCode, vatNumber: q.vatNumber };
    if (requester && requester.length > 2) {
      body.requesterMemberStateCode = requester.slice(0, 2);
      body.requesterNumber = requester.slice(2);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const at = now();
      if (res.status >= 500) return { result: notChecked(`VIES unreachable (HTTP ${res.status})`, at), requesterRefused: false };
      let json: any;
      try {
        json = await res.json();
      } catch {
        return { result: notChecked(`VIES answered HTTP ${res.status} without a readable body`, at), requesterRefused: false };
      }
      const code = (Array.isArray(json?.errorWrappers) && json.errorWrappers[0]?.error) || json?.userError;
      if (code === "INVALID_REQUESTER_INFO") return { result: notChecked("VIES refused the requester", at), requesterRefused: true };
      return { result: mapViesResponse(json, at, log), requesterRefused: false };
    } catch (err) {
      const at = now();
      if (controller.signal.aborted) {
        return { result: notChecked(`VIES unreachable (timeout after ${Math.round(timeoutMs / 100) / 10} s)`, at), requesterRefused: false };
      }
      return { result: notChecked(`VIES unreachable (${err instanceof Error ? err.message : String(err)})`, at), requesterRefused: false };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(q) {
      const timeoutMs = Math.min(clientTimeout, q.timeoutMs ?? clientTimeout);
      const first = await once(q, q.requester, timeoutMs);
      if (!first.requesterRefused || !q.requester) return first.result;
      // VIES refused our own VAT ID as requester — retry once without it (no consultation number).
      const second = await once(q, null, timeoutMs);
      if (second.result.status === "valid" || second.result.status === "invalid") {
        return { ...second.result, request_id: null, reason: "requester VAT ID refused by VIES — checked without a consultation number" };
      }
      return second.result;
    },
  };
}

/** A client that never calls out — ERP_VIES=off. */
export function offViesClient(now: () => Date = () => new Date()): ViesClient {
  return { async check() { return notChecked("VIES check switched off", now()); } };
}

export function viesClientFromEnv(env: NodeJS.ProcessEnv = process.env): ViesClient {
  if ((env.ERP_VIES ?? "").trim().toLowerCase() === "off") return offViesClient();
  const t = Number(env.ERP_VIES_TIMEOUT_MS);
  return httpViesClient({
    url: env.ERP_VIES_URL?.trim() || DEFAULT_VIES_URL,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : DEFAULT_VIES_TIMEOUT_MS,
  });
}
