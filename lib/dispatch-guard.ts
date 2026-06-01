// lib/dispatch-guard.ts
//
// HTTP hardening primitives for the /api/dispatch webhook (Task 4):
//   - sliding-window rate limiter (per client key, default 10/min)
//   - idempotency cache (X-Dispatch-Id → cached response, 5-min TTL)
//   - append-only JSONL audit log of every dispatch attempt
//
// The rate-limiter and idempotency cache are in-memory module singletons —
// they live for the lifetime of the server process (one shared instance
// across all requests, like the scheduler). The audit log is durable.
//
// Doctrine: all of this is best-effort and NON-FATAL. A failure to write the
// audit log, or any guard error, must never block or crash a dispatch.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";

// ----- config -----

/** Max POST /api/dispatch requests per client key per window. Env override
 *  lets ops widen/narrow without a redeploy. */
export const RATE_LIMIT_PER_MIN = (() => {
  const n = Number(process.env.DISPATCH_RATELIMIT_PER_MIN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
})();
const RATE_WINDOW_MS = 60_000;
const IDEMPOTENCY_TTL_MS = 5 * 60_000;

/** Allowed event types over the HTTP contract (directive). The dispatcher
 *  internally accepts free-form types from in-process callers (e.g. the
 *  heartbeat), but the public webhook is restricted to this set. */
export const ALLOWED_TYPES = ["security", "research", "ops", "comms", "heartbeat"] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

export const MAX_CONTENT_CHARS = 2000;
export const MAX_SOURCE_CHARS = 100;

// ----- rate limiter (sliding window) -----

const hits = new Map<string, number[]>(); // client key → request timestamps (ms)

export interface RateResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSec: number;
}

/** Record a request for `key` at `nowMs` and report whether it's allowed.
 *  Sliding window: only timestamps within the last 60s count. */
export function checkRateLimit(key: string, nowMs: number): RateResult {
  const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    hits.set(key, recent); // persist the trimmed window
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((RATE_WINDOW_MS - (nowMs - oldest)) / 1000));
    return { allowed: false, remaining: 0, limit: RATE_LIMIT_PER_MIN, retryAfterSec };
  }
  recent.push(nowMs);
  hits.set(key, recent);
  // Opportunistic cleanup so the map can't grow unbounded over weeks.
  if (hits.size > 4096) {
    for (const [k, arr] of hits) {
      const live = arr.filter((t) => nowMs - t < RATE_WINDOW_MS);
      if (live.length === 0) hits.delete(k);
      else hits.set(k, live);
    }
  }
  return { allowed: true, remaining: RATE_LIMIT_PER_MIN - recent.length, limit: RATE_LIMIT_PER_MIN, retryAfterSec: 0 };
}

// ----- idempotency cache -----

interface IdemEntry {
  at: number;
  response: unknown;
}
const idem = new Map<string, IdemEntry>();

/** Return a cached response for `id` if one was stored within the TTL, else
 *  null. Expired entries are evicted on access. */
export function getIdempotent(id: string, nowMs: number): unknown | null {
  const e = idem.get(id);
  if (!e) return null;
  if (nowMs - e.at > IDEMPOTENCY_TTL_MS) {
    idem.delete(id);
    return null;
  }
  return e.response;
}

/** Cache `response` under `id`. Sweeps expired entries when the map is large. */
export function storeIdempotent(id: string, response: unknown, nowMs: number): void {
  idem.set(id, { at: nowMs, response });
  if (idem.size > 2048) {
    for (const [k, v] of idem) {
      if (nowMs - v.at > IDEMPOTENCY_TTL_MS) idem.delete(k);
    }
  }
}

// ----- audit log (append-only JSONL) -----

export type DispatchOutcome = "success" | "rate-limited" | "duplicate" | "invalid" | "error";

export interface DispatchAuditEntry {
  at: string; // ISO
  outcome: DispatchOutcome;
  ip: string;
  type: string | null;
  source: string | null;
  dispatchId: string | null;
  detail?: string;
}

export function dispatchAuditPath(): string {
  return path.join(argosRoot(), "state", "dispatch-audit.jsonl");
}

/** Append one audit entry. Best-effort: a logging failure never blocks the
 *  request. Append-only JSONL — one self-describing line per attempt. */
export async function logDispatchAttempt(entry: DispatchAuditEntry): Promise<void> {
  try {
    const file = dispatchAuditPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[dispatch-guard] audit append failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/** Validate the public webhook contract. Returns an error string or null. */
export function validateDispatchInput(input: {
  type: unknown;
  content: unknown;
  source: unknown;
}): string | null {
  const { type, content, source } = input;
  if (typeof type !== "string" || !type.trim()) return "type is required";
  if (!ALLOWED_TYPES.includes(type.trim().toLowerCase() as AllowedType)) {
    return `type must be one of ${ALLOWED_TYPES.join(", ")}`;
  }
  if (typeof content !== "string" || !content.trim()) return "content is required";
  if (content.length > MAX_CONTENT_CHARS) {
    return `content too long (${content.length} > ${MAX_CONTENT_CHARS})`;
  }
  if (source !== undefined && source !== null) {
    if (typeof source !== "string") return "source must be a string";
    if (source.length > MAX_SOURCE_CHARS) {
      return `source too long (${source.length} > ${MAX_SOURCE_CHARS})`;
    }
  }
  return null;
}

/** Test-only: reset all in-memory guard state. */
export function _resetGuardForTests(): void {
  hits.clear();
  idem.clear();
}
