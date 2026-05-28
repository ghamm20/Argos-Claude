// lib/research/cache.ts
//
// Simple file-backed JSON cache at $ARGOS_ROOT/data/research/cache.json.
// One object per cache key. Atomic write via temp+rename so a yanked
// USB mid-write can't leave a half-written file. Expired entries are
// pruned on every write and on demand.
//
// Cache key design: intent + location-or-empty + UTC-day. Same
// query on the same day reuses the entry; a new day forces a
// refresh even if TTL hasn't expired (gives the operator predictable
// daily-fresh news/weather without staleness).

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import type {
  ResearchCache,
  ResearchIntent,
  ResearchLocation,
  ResearchReport,
  CacheEntry,
} from "./types";

// ----- paths -----

function researchDir(): string {
  if (process.env.ARGOS_DATA_DIR && process.env.ARGOS_DATA_DIR.length > 0) {
    return path.join(process.env.ARGOS_DATA_DIR, "research");
  }
  return path.join(argosRoot(), "data", "research");
}

function cachePath(): string {
  return path.join(researchDir(), "cache.json");
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(researchDir(), { recursive: true });
}

// ----- read / write helpers -----

async function readCache(): Promise<ResearchCache> {
  try {
    const raw = await fsp.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as ResearchCache;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Malformed cache → don't crash; treat as empty + log.
    // eslint-disable-next-line no-console
    console.warn(
      `[research/cache] read failed: ${(e as Error).message} — treating as empty`
    );
    return {};
  }
}

async function writeCache(cache: ResearchCache): Promise<void> {
  await ensureDir();
  const final = cachePath();
  const tmp = `${final}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(cache, null, 2), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
}

// ----- key building -----

/** Build a stable cache key. Daily granularity (UTC day) so the cache
 *  flushes naturally across days even within TTL — keeps weather +
 *  news from going stale on a long-running deployment. */
export function buildCacheKey(
  intent: ResearchIntent,
  location?: ResearchLocation
): string {
  const day = new Date().toISOString().slice(0, 10);
  const loc = location ?? "all";
  return `${intent}:${loc}:${day}`;
}

// ----- public API -----

/** Return the report from cache if present + not expired, else null. */
export async function getCachedReport(
  cacheKey: string
): Promise<ResearchReport | null> {
  const cache = await readCache();
  const entry = cache[cacheKey];
  if (!entry) return null;
  const exp = Date.parse(entry.expiresAt);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  // Stamp the cachedAt timestamp on the way out so consumers can
  // render "served from cache (age 4m)" without storing extra fields.
  return { ...entry.report, cachedAt: entry.report.generatedAt };
}

/** Persist a report with TTL derived from its `ttlMinutes` field. */
export async function cacheReport(
  cacheKey: string,
  report: ResearchReport
): Promise<void> {
  await ensureDir();
  const cache = await readCache();
  const expiresAt = new Date(
    Date.now() + Math.max(1, report.ttlMinutes) * 60_000
  ).toISOString();
  cache[cacheKey] = { report, expiresAt };
  // Prune-while-writing: drop any expired entries discovered on the
  // way past.
  for (const k of Object.keys(cache)) {
    const e = cache[k];
    if (!e) continue;
    if (Date.parse(e.expiresAt) <= Date.now()) delete cache[k];
  }
  await writeCache(cache);
}

/** Walk the cache and drop expired entries. Returns the count
 *  removed. */
export async function pruneCache(): Promise<number> {
  if (!existsSync(cachePath())) return 0;
  const cache = await readCache();
  let removed = 0;
  for (const k of Object.keys(cache)) {
    const e = cache[k];
    if (!e || Date.parse(e.expiresAt) <= Date.now()) {
      delete cache[k];
      removed++;
    }
  }
  if (removed > 0) await writeCache(cache);
  return removed;
}

/** Return a summarized view for the Tools UI. */
export interface CacheStatusEntry {
  cacheKey: string;
  intent: ResearchIntent;
  expiresAt: string;
  generatedAt: string;
  quality: string;
  confidenceScore: number;
  resultCount: number;
  sizeBytes: number;
}

export async function getCacheStatus(): Promise<{
  totalEntries: number;
  totalSizeBytes: number;
  entries: CacheStatusEntry[];
}> {
  const cache = await readCache();
  const entries: CacheStatusEntry[] = [];
  let totalSize = 0;
  for (const [cacheKey, e] of Object.entries(cache)) {
    if (!e) continue;
    const size = Buffer.byteLength(JSON.stringify(e), "utf8");
    totalSize += size;
    entries.push({
      cacheKey,
      intent: e.report.intent,
      expiresAt: e.expiresAt,
      generatedAt: e.report.generatedAt,
      quality: e.report.quality,
      confidenceScore: e.report.confidenceScore,
      resultCount: e.report.results.length,
      sizeBytes: size,
    });
  }
  entries.sort((a, b) =>
    a.expiresAt < b.expiresAt ? 1 : -1
  );
  return {
    totalEntries: entries.length,
    totalSizeBytes: totalSize,
    entries,
  };
}

/** Drop all cache entries. */
export async function clearCache(): Promise<number> {
  if (!existsSync(cachePath())) return 0;
  const cache = await readCache();
  const n = Object.keys(cache).length;
  await writeCache({} as ResearchCache);
  return n;
}

/** Lookup an entry by its expired/live status — used by the UI for
 *  the per-entry age display. */
export async function findEntry(
  cacheKey: string
): Promise<CacheEntry | null> {
  const cache = await readCache();
  return cache[cacheKey] ?? null;
}
