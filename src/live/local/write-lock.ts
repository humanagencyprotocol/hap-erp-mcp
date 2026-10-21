/**
 * One lock and one transaction rule for every Local write (review 2026-10-21,
 * finding 1).
 *
 * The Local DB is one better-sqlite3 connection behind an async wrapper. Two
 * writes in flight at once used to interleave at their `await`s: the second
 * `BEGIN` threw "cannot start a transaction within a transaction" AFTER the
 * first had written its archive PDF — an orphan PDF, a burned number, and for
 * quotes a revision file that blocked every later revision.
 *
 * - `withLocalLock(fn)`: runs `fn` after every earlier holder has finished —
 *   one queue per process. Re-entrant (AsyncLocalStorage): a locked write
 *   called from inside a locked dispatch call runs directly instead of
 *   waiting on itself. dispatch.ts puts EVERY Local tool call through it
 *   (reads too, so no read ever sees a write's uncommitted rows); the write
 *   handlers and the CLI writers take it themselves as well, so a direct call
 *   (tests, CLI) is serialised the same way.
 * - `inTransaction(db, fn, onRollback?)`: `BEGIN IMMEDIATE` (takes SQLite's
 *   write lock at once, so another process — e.g. an older erp-mcp sharing
 *   the data dir — waits on busy_timeout instead of failing mid-way), COMMIT,
 *   or ROLLBACK + `onRollback` on any error, including a failed COMMIT.
 *   Callers write the archive PDF as the LAST step inside `fn` and delete it
 *   in `onRollback`: no row without its PDF, no PDF without its row.
 */
import { AsyncLocalStorage } from "async_hooks";
import type { Db } from "../../db.js";

const held = new AsyncLocalStorage<true>();
let tail: Promise<void> = Promise.resolve();

export function withLocalLock<T>(fn: () => Promise<T>): Promise<T> {
  if (held.getStore()) return fn();
  const run = tail.then(() => held.run(true, fn));
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Wraps a write handler so every call of it holds the Local lock. */
export function locked<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A) => withLocalLock(() => fn(...args));
}

export async function inTransaction<T>(db: Db, fn: () => Promise<T>, onRollback?: () => void): Promise<T> {
  await db.run("BEGIN IMMEDIATE");
  try {
    const out = await fn();
    await db.run("COMMIT");
    return out;
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    try {
      onRollback?.();
    } catch {
      // the original error is what the caller must see
    }
    throw err;
  }
}
