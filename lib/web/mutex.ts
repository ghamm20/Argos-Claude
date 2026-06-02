// lib/web/mutex.ts
//
// Web Capability (2026-06-02) — a tiny in-process async mutex keyed by a string.
// Serializes read-modify-write of SHARED state files (rate-limits.json, the
// cache stats counter) so concurrent webFetch calls — e.g. chain_search_to_read
// firing a search + parallel page reads — don't race on temp+rename. On Windows
// two concurrent renames to the SAME target throw EPERM/EACCES; unique temp
// names alone don't fix that. Serializing the whole critical section does, and
// it also removes lost-update races (last-writer-wins) for free.

const tails = new Map<string, Promise<unknown>>();

/** Run `fn` exclusively with respect to other withLock calls for the same key.
 *  The caller receives fn's real result/rejection; the internal chain swallows
 *  errors so one failure never deadlocks the next waiter. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = (tails.get(key) ?? Promise.resolve()).catch(() => undefined);
  const result = prev.then(fn);
  tails.set(key, result.catch(() => undefined));
  return result;
}
