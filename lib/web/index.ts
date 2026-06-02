// lib/web/index.ts
//
// Web Capability TIER 0 (2026-06-02) — the workhorse every web tool calls.
// webFetch() composes the four infra pieces in order:
//   1. cache    — return a fresh cached body if present (audit cacheHit)
//   2. rate     — token-bucket the source; bounded wait, else degrade
//   3. http     — the retrying/timeout/UA-rotating client (Rule-4 safe)
//   4. audit    — append the call to state/web-audit.jsonl
//
// Tools NEVER call fetch() directly. They build a URL value and hand it here,
// which keeps verify-argos Rule 4 green and centralizes governance.

import { cacheGet, cacheSet, cacheKey } from "./cache";
import { take, limitFor, type RateConfig } from "./rate-limiter";
import { httpRequest, type HttpOptions } from "./http-client";
import { appendWebAudit } from "./audit";
import { isDisabled } from "./disabled";
import { readSettings } from "../settings";
import { decryptSecret } from "./secrets";

export interface WebFetchOptions {
  /** Source id used for rate limiting + audit (e.g. "wikipedia"). */
  source: string;
  /** Short op label for the audit ("search", "fetch", "readme"). */
  op: string;
  /** The URL to fetch (a VALUE — never an inline literal in fetch()). */
  url: string;
  /** Human-readable query/target for the audit. */
  query?: string;
  /** Cache TTL in ms. 0 disables caching for this call. */
  ttlMs: number;
  /** Per-source rate config override. */
  rate?: RateConfig;
  /** Max ms to wait when rate-limited before degrading to a soft failure. */
  maxRateWaitMs?: number;
  // HTTP passthrough
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  maxChars?: number;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  ok: boolean;
  status: number;
  body: string;
  fromCache: boolean;
  latencyMs: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cache → rate-limit → fetch → audit. Never throws.
 */
export async function webFetch(opts: WebFetchOptions): Promise<WebFetchResult> {
  const key = cacheKey(opts.url, { method: opts.method ?? "GET", body: opts.body ?? "" });

  // 0) Operator kill switch — a disabled source never hits the network.
  if (await isDisabled(opts.source)) {
    await appendWebAudit({
      source: opts.source, op: opts.op, query: opts.query ?? "", url: opts.url,
      status: 0, ok: false, latencyMs: 0, cacheHit: false, cost: 0,
      error: "source disabled by operator",
    });
    return { ok: false, status: 0, body: "", fromCache: false, latencyMs: 0, error: `source "${opts.source}" is disabled by the operator` };
  }

  // 1) Cache hit?
  if (opts.ttlMs > 0) {
    const cached = await cacheGet<{ status: number; body: string }>(key);
    if (cached) {
      await appendWebAudit({
        source: opts.source,
        op: opts.op,
        query: opts.query ?? "",
        url: opts.url,
        status: cached.status,
        ok: true,
        latencyMs: 0,
        cacheHit: true,
        cost: 0,
        error: null,
      });
      return { ok: true, status: cached.status, body: cached.body, fromCache: true, latencyMs: 0 };
    }
  }

  // 2) Rate limit (bounded wait, then degrade).
  const rate = opts.rate ?? limitFor(opts.source);
  const maxWait = opts.maxRateWaitMs ?? 2500;
  const t = await take(opts.source, rate);
  if (!t.allowed) {
    if (t.waitMs <= maxWait) {
      await sleep(t.waitMs);
    } else {
      await appendWebAudit({
        source: opts.source,
        op: opts.op,
        query: opts.query ?? "",
        url: opts.url,
        status: 429,
        ok: false,
        latencyMs: 0,
        cacheHit: false,
        cost: 0,
        error: `rate-limited (wait ${t.waitMs}ms)`,
      });
      return { ok: false, status: 429, body: "", fromCache: false, latencyMs: 0, error: `rate-limited for ${opts.source}` };
    }
  }

  // 3) HTTP.
  const httpOpts: HttpOptions = {
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    userAgent: opts.userAgent,
    maxChars: opts.maxChars,
    signal: opts.signal,
  };
  const r = await httpRequest(opts.url, httpOpts);

  // 4) Cache the success + audit either way.
  if (r.ok && opts.ttlMs > 0) {
    await cacheSet(key, opts.url, { status: r.status, body: r.body }, opts.ttlMs);
  }
  await appendWebAudit({
    source: opts.source,
    op: opts.op,
    query: opts.query ?? "",
    url: opts.url,
    status: r.status,
    ok: r.ok,
    latencyMs: r.latencyMs,
    cacheHit: false,
    cost: 0,
    error: r.error ?? null,
  });

  return { ok: r.ok, status: r.status, body: r.body, fromCache: false, latencyMs: r.latencyMs, error: r.error };
}

/** JSON convenience over webFetch. Returns parsed data or { ok:false }. */
export async function webFetchJson<T = unknown>(
  opts: WebFetchOptions
): Promise<{ ok: boolean; status: number; data: T | null; fromCache: boolean; error?: string }> {
  const r = await webFetch({ ...opts, headers: { accept: "application/json", ...(opts.headers ?? {}) } });
  if (!r.ok) return { ok: false, status: r.status, data: null, fromCache: r.fromCache, error: r.error };
  try {
    return { ok: true, status: r.status, data: JSON.parse(r.body) as T, fromCache: r.fromCache };
  } catch (e) {
    return { ok: false, status: r.status, data: null, fromCache: r.fromCache, error: `bad JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type ApiKeyName = "github";

/** Decrypted API secret from settings, or null if unset. Never logged. */
export async function getApiKey(name: ApiKeyName): Promise<string | null> {
  try {
    const s = await readSettings();
    const stored = s.apiKeys?.[name] ?? null;
    if (!stored) return null;
    return await decryptSecret(stored);
  } catch {
    return null;
  }
}
