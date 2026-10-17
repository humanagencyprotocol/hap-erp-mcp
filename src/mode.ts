/**
 * Connector mode: `simulation` answers from the built-in simulated ERP (SQLite);
 * `live` talks to a real system through a live adapter.
 *
 * The switch exists so a three-week test runs on exactly the connector, tools and
 * profile that go live later — only the system behind the connector changes.
 * `live` requires ERP_LIVE_ADAPTER naming an installed adapter; without one it
 * refuses every call loudly instead of silently falling back to the simulation:
 * a test that believes it is live (or a go-live that is secretly still
 * simulated) is the failure this must not hide.
 *
 * `local` is this connector's first live adapter: Suveren's own invoicing on
 * this machine (own database, real company data, no simulation tools). Other
 * live adapters (SAP, BMD, ...) plug in the same way — same ERP_MODE=live
 * switch, a different ERP_LIVE_ADAPTER value.
 */

export type ErpMode = "simulation" | "live";

export const MODES: readonly ErpMode[] = ["simulation", "live"];

export type LiveAdapter = "local";

export const LIVE_ADAPTERS: readonly LiveAdapter[] = ["local"];

/** Reads ERP_MODE (default `simulation`). An unknown value stops the server at start. */
export function getMode(env: NodeJS.ProcessEnv = process.env): ErpMode {
  const raw = (env.ERP_MODE ?? "").trim().toLowerCase();
  if (raw === "") return "simulation";
  if ((MODES as readonly string[]).includes(raw)) return raw as ErpMode;
  throw new Error(`ERP_MODE must be one of ${MODES.join(", ")} — got ${JSON.stringify(env.ERP_MODE)}.`);
}

/**
 * Reads ERP_LIVE_ADAPTER. Undefined (unset) means "no adapter installed" —
 * the caller falls back to LIVE_NOT_AVAILABLE. An unknown non-empty value
 * stops the server at start, the same way an unknown ERP_MODE does.
 */
export function getLiveAdapter(env: NodeJS.ProcessEnv = process.env): LiveAdapter | undefined {
  const raw = (env.ERP_LIVE_ADAPTER ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  if ((LIVE_ADAPTERS as readonly string[]).includes(raw)) return raw as LiveAdapter;
  throw new Error(`ERP_LIVE_ADAPTER must be one of ${LIVE_ADAPTERS.join(", ")} — got ${JSON.stringify(env.ERP_LIVE_ADAPTER)}.`);
}

export const LIVE_NOT_AVAILABLE =
  "Refused: this ERP connector is in live mode, but no live ERP adapter is installed. " +
  "Nothing was read or changed. Set ERP_MODE=simulation, or set ERP_LIVE_ADAPTER (e.g. \"local\") to install one.";
