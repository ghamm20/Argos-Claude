// lib/chat/inflight.ts
//
// Phase 11 — shared in-flight chat counter. Incremented when /api/chat
// begins processing a request, decremented when the response stream
// closes (or errors / aborts). The scheduler reads this before
// firing a tick — if any chat is in progress, the tick is deferred
// to the next interval to avoid hammering Ollama or the network.
//
// Module-scope state. Safe for single Next.js process (which is the
// only mode ARGOS runs in by design).

let counter = 0;

/** Bump the counter on chat POST entry. Always paired with end(). */
export function begin(): void {
  counter++;
}

/** Decrement; floor at 0 so a stray end() call can't push negative. */
export function end(): void {
  counter = Math.max(0, counter - 1);
}

/** True when at least one chat is currently being processed. */
export function isInFlight(): boolean {
  return counter > 0;
}

/** Current count — exported for diagnostic UIs only. */
export function inFlightCount(): number {
  return counter;
}

/** Test-only reset. */
export function _resetInFlight(): void {
  counter = 0;
}
