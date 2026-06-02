// lib/web/cache.ts
//
// Web Capability TIER 0 (2026-06-02) — disk-backed response cache at
// state/web-cache/. One file per key: <sha1(url+params)>.json. TTL is set per
// entry by the caller (news 15m, Wikipedia/arXiv 24h, …). Atomic temp+rename
// writes so a yanked USB can't leave a half-written entry.
//
// Hit/miss counters are persisted in _stats.json so the stats endpoint can
// report a real hit rate without scanning the audit log.

import { promises as fsp, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { webCacheDir } from "./paths";

export function cacheKey(url: string, params?: Record<string, unknown>): string {
  const basis = params ? `${url}|${JSON.stringify(params)}` : url;
  return createHash("sha1").update(basis).digest("hex");
}

interface CacheFile<T = unknown> {
  url: string;
  key: string;
  savedAt: string; // ISO
  expiresAt: string; // ISO
  value: T;
}

interface CacheStats {
  hits: number;
  misses: number;
}

function entryPath(key: string): string {
  return path.join(webCacheDir(), `${key}.json`);
}
function statsPath(): string {
  return path.join(webCacheDir(), "_stats.json");
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(webCacheDir(), { recursive: true });
}

// Unique temp suffix per write so concurrent writers (e.g. parallel cache
// stats bumps from the chain tool's fan-out) don't race on the same temp path.
let tmpSeq = 0;

async function atomicWrite(file: string, data: string): Promise<void> {
  await ensureDir();
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

async function readStats(): Promise<CacheStats> {
  try {
    const raw = await fsp.readFile(statsPath(), "utf8");
    const p = JSON.parse(raw) as Partial<CacheStats>;
    return { hits: p.hits ?? 0, misses: p.misses ?? 0 };
  } catch {
    return { hits: 0, misses: 0 };
  }
}

async function bumpStats(field: keyof CacheStats): Promise<void> {
  try {
    const s = await readStats();
    s[field] += 1;
    await atomicWrite(statsPath(), JSON.stringify(s));
  } catch {
    /* stats are best-effort */
  }
}

/** Return the cached value if present and not expired, else null. */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(entryPath(key), "utf8");
    const parsed = JSON.parse(raw) as CacheFile<T>;
    const exp = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(exp) || exp <= Date.now()) {
      await bumpStats("misses");
      // best-effort prune of the stale file
      try {
        await fsp.unlink(entryPath(key));
      } catch {
        /* ignore */
      }
      return null;
    }
    await bumpStats("hits");
    return parsed.value;
  } catch {
    await bumpStats("misses");
    return null;
  }
}

/** Persist a value with a TTL in milliseconds. */
export async function cacheSet<T = unknown>(
  key: string,
  url: string,
  value: T,
  ttlMs: number
): Promise<void> {
  const now = Date.now();
  const file: CacheFile<T> = {
    url,
    key,
    savedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(1, ttlMs)).toISOString(),
    value,
  };
  await atomicWrite(entryPath(key), JSON.stringify(file));
}

/** Remove every cache entry (keeps the stats counters). Returns count removed. */
export async function cacheClear(): Promise<number> {
  if (!existsSync(webCacheDir())) return 0;
  let removed = 0;
  for (const name of await fsp.readdir(webCacheDir())) {
    if (!name.endsWith(".json") || name === "_stats.json") continue;
    try {
      await fsp.unlink(path.join(webCacheDir(), name));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export interface WebCacheStats {
  entries: number;
  sizeBytes: number;
  oldestAt: string | null;
  newestAt: string | null;
  hits: number;
  misses: number;
  hitRate: number; // 0..1
}

/** Summary for the stats endpoint / Tools page. */
export async function cacheStats(): Promise<WebCacheStats> {
  const stats = await readStats();
  let entries = 0;
  let sizeBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  if (existsSync(webCacheDir())) {
    for (const name of await fsp.readdir(webCacheDir())) {
      if (!name.endsWith(".json") || name === "_stats.json") continue;
      try {
        const full = path.join(webCacheDir(), name);
        const st = await fsp.stat(full);
        sizeBytes += st.size;
        entries++;
        const raw = await fsp.readFile(full, "utf8");
        const parsed = JSON.parse(raw) as CacheFile;
        const t = Date.parse(parsed.savedAt);
        if (Number.isFinite(t)) {
          if (oldest === null || t < oldest) oldest = t;
          if (newest === null || t > newest) newest = t;
        }
      } catch {
        /* skip unreadable entry */
      }
    }
  }
  const total = stats.hits + stats.misses;
  return {
    entries,
    sizeBytes,
    oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    newestAt: newest === null ? null : new Date(newest).toISOString(),
    hits: stats.hits,
    misses: stats.misses,
    hitRate: total > 0 ? stats.hits / total : 0,
  };
}
