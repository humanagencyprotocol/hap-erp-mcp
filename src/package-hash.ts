/**
 * Canonical hash of a simulation package — used to prove which exact package a
 * `load_simulation` call loaded, independent of key order. JSON.stringify on an
 * object with the same keys in a different order produces different bytes, so a
 * naive hash of the raw payload would call the same package "different" just
 * because a client re-serialized it.
 */
import { createHash } from "crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of `value`, serialized with every object's keys sorted recursively. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}
