// lib/web/audit.ts
//
// Web Capability TIER 0 (2026-06-02) — append-only external-call ledger at
// state/web-audit.jsonl. Every call through the web client lands here: source,
// query, status, latency, cache hit/miss, cost (if a source ever charges).
// queryAudit() powers the Tools/Loops surfaces. Append-only; never rewritten.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { webAuditPath } from "./paths";

export interface WebAuditEntry {
  at: string; // ISO timestamp
  source: string; // e.g. "wikipedia", "github"
  op: string; // e.g. "search", "fetch", "readme"
  query: string; // human-readable query / target (truncated)
  url: string; // requested URL (truncated)
  status: number; // HTTP status (0 = network error / cache)
  ok: boolean;
  latencyMs: number;
  cacheHit: boolean;
  cost: number; // 0 for all keyless/self-hosted sources
  error: string | null;
}

export async function appendWebAudit(
  entry: Omit<WebAuditEntry, "at"> & { at?: string }
): Promise<void> {
  const rec: WebAuditEntry = {
    at: entry.at ?? new Date().toISOString(),
    source: entry.source,
    op: entry.op,
    query: (entry.query ?? "").slice(0, 200),
    url: (entry.url ?? "").slice(0, 400),
    status: entry.status,
    ok: entry.ok,
    latencyMs: entry.latencyMs,
    cacheHit: entry.cacheHit,
    cost: entry.cost ?? 0,
    error: entry.error ?? null,
  };
  try {
    await fsp.mkdir(path.dirname(webAuditPath()), { recursive: true });
    await fsp.appendFile(webAuditPath(), JSON.stringify(rec) + "\n", "utf8");
  } catch {
    /* audit is best-effort — never break a tool because the log write failed */
  }
}

async function readAll(): Promise<WebAuditEntry[]> {
  try {
    const raw = await fsp.readFile(webAuditPath(), "utf8");
    const out: WebAuditEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as WebAuditEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface AuditQuery {
  source?: string;
  /** Only entries at/after this ISO time. */
  since?: string;
  limit?: number;
}

export interface AuditSummary {
  total: number;
  callsToday: number;
  cacheHitRate: number; // 0..1 over the returned window
  errors24h: number;
  bySource: Record<string, { calls: number; errors: number; cacheHits: number; avgLatencyMs: number }>;
  recent: WebAuditEntry[];
}

/** Filtered audit window + aggregates for the Tools/Loops page. */
export async function queryAudit(q: AuditQuery = {}): Promise<AuditSummary> {
  const all = await readAll();
  const sinceMs = q.since ? Date.parse(q.since) : null;
  const filtered = all.filter((e) => {
    if (q.source && e.source !== q.source) return false;
    if (sinceMs !== null && Number.isFinite(sinceMs) && Date.parse(e.at) < sinceMs) return false;
    return true;
  });

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;

  const bySource: AuditSummary["bySource"] = {};
  let cacheHits = 0;
  let callsToday = 0;
  let errors24h = 0;
  const latencySum: Record<string, number> = {};

  for (const e of filtered) {
    const t = Date.parse(e.at);
    if (e.cacheHit) cacheHits++;
    if (Number.isFinite(t) && t >= dayStartMs) callsToday++;
    if (!e.ok && Number.isFinite(t) && t >= cutoff24h) errors24h++;
    const s = (bySource[e.source] ??= { calls: 0, errors: 0, cacheHits: 0, avgLatencyMs: 0 });
    s.calls++;
    if (!e.ok) s.errors++;
    if (e.cacheHit) s.cacheHits++;
    latencySum[e.source] = (latencySum[e.source] ?? 0) + e.latencyMs;
  }
  for (const src of Object.keys(bySource)) {
    bySource[src].avgLatencyMs = Math.round(latencySum[src] / Math.max(1, bySource[src].calls));
  }

  const limit = q.limit ?? 100;
  const recent = filtered.slice(-limit).reverse();

  return {
    total: filtered.length,
    callsToday,
    cacheHitRate: filtered.length > 0 ? cacheHits / filtered.length : 0,
    errors24h,
    bySource,
    recent,
  };
}
