import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A settings path as people type it: a leading "~" means the home directory.
 * The gateway passes setting values through unchanged, and Node does not
 * expand "~" (found 2026-10-18: "~/Documents/…/company.json" → ENOENT).
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
