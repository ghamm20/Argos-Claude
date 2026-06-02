// lib/web/rate-limiter.ts
//
// Web Capability TIER 0 (2026-06-02) — per-source token bucket. State persists
// to state/rate-limits.json so limits survive restarts. take() NEVER blocks —
// it returns { allowed, waitMs } and the caller decides whether to wait or
// fail. This honors public-API courtesy limits (e.g. NCBI 3/sec, SE 300/day).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { rateLimitsPath } from "./paths";

export interface RateConfig {
  /** Sustained rate. */
  requestsPerMinute: number;
  /** Bucket capacity (max burst). */
  burst: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

type BucketState = Record<string, Bucket>;

/** Sensible default limits per source (courtesy, not hard quotas). */
export const SOURCE_LIMITS: Record<string, RateConfig> = {
  wikipedia: { requestsPerMinute: 100, burst: 20 },
  wikidata: { requestsPerMinute: 30, burst: 5 },
  arxiv: { requestsPerMinute: 20, burst: 5 },
  openalex: { requestsPerMinute: 100, burst: 20 },
  papers_with_code: { requestsPerMinute: 60, burst: 10 },
  huggingface: { requestsPerMinute: 100, burst: 20 },
  crossref: { requestsPerMinute: 50, burst: 10 },
  pubmed: { requestsPerMinute: 150, burst: 3 }, // NCBI ~3/sec without key
  gdelt: { requestsPerMinute: 30, burst: 5 },
  open_meteo: { requestsPerMinute: 120, burst: 20 }, // generous; no published limit
  searxng: { requestsPerMinute: 120, burst: 20 }, // self-hosted, generous
  github: { requestsPerMinute: 80, burst: 20 },
  stackexchange: { requestsPerMinute: 30, burst: 10 },
  sec_edgar: { requestsPerMinute: 60, burst: 10 }, // SEC asks ≤10/sec
  jina_reader: { requestsPerMinute: 40, burst: 10 },
  rsshub: { requestsPerMinute: 120, burst: 20 }, // self-hosted
  firecrawl_alt: { requestsPerMinute: 60, burst: 10 },
};

export function limitFor(source: string): RateConfig {
  return SOURCE_LIMITS[source] ?? { requestsPerMinute: 30, burst: 5 };
}

async function readState(): Promise<BucketState> {
  try {
    const raw = await fsp.readFile(rateLimitsPath(), "utf8");
    const parsed = JSON.parse(raw) as BucketState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Unique temp suffix per write — concurrent webFetch calls (e.g. the chain
// tool's parallel reads) must not collide on the same temp path, or one
// rename races ahead and the other hits ENOENT.
let tmpSeq = 0;

async function writeState(state: BucketState): Promise<void> {
  const final = rateLimitsPath();
  const tmp = `${final}.${process.pid}.${++tmpSeq}.tmp`;
  // Ensure the parent (state/) exists.
  await fsp.mkdir(path.dirname(final), { recursive: true });
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(state), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
}

export interface TakeResult {
  allowed: boolean;
  /** When !allowed, ms until at least one token is available. */
  waitMs: number;
  tokensRemaining: number;
}

/**
 * Attempt to consume one token from a source's bucket. Refills based on
 * elapsed time since last refill. Never blocks. Persists state.
 */
export async function take(
  source: string,
  config: RateConfig = limitFor(source)
): Promise<TakeResult> {
  const now = Date.now();
  const state = await readState();
  const ratePerMs = config.requestsPerMinute / 60_000;
  const existing = state[source];
  let tokens = existing ? existing.tokens : config.burst;
  const last = existing ? existing.lastRefillMs : now;
  // Refill.
  tokens = Math.min(config.burst, tokens + (now - last) * ratePerMs);

  let result: TakeResult;
  if (tokens >= 1) {
    tokens -= 1;
    result = { allowed: true, waitMs: 0, tokensRemaining: Math.floor(tokens) };
  } else {
    const deficit = 1 - tokens;
    const waitMs = ratePerMs > 0 ? Math.ceil(deficit / ratePerMs) : 60_000;
    result = { allowed: false, waitMs, tokensRemaining: 0 };
  }
  state[source] = { tokens, lastRefillMs: now };
  await writeState(state);
  return result;
}

/** Current bucket levels for the stats endpoint. */
export async function rateStatus(): Promise<
  Array<{ source: string; tokens: number; burst: number; requestsPerMinute: number }>
> {
  const state = await readState();
  const now = Date.now();
  return Object.keys({ ...SOURCE_LIMITS, ...state }).map((source) => {
    const cfg = limitFor(source);
    const b = state[source];
    const ratePerMs = cfg.requestsPerMinute / 60_000;
    const tokens = b
      ? Math.min(cfg.burst, b.tokens + (now - b.lastRefillMs) * ratePerMs)
      : cfg.burst;
    return {
      source,
      tokens: Math.floor(tokens),
      burst: cfg.burst,
      requestsPerMinute: cfg.requestsPerMinute,
    };
  });
}
