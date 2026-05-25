// lib/audit.ts
//
// Phase 4 audit chain. Append-only JSONL at $ARGOS_ROOT/state/audit/chain.jsonl.
// Every entry hash-links to its predecessor; tamper-detection walks the chain.
//
// This is the foundation Tier 11 of the autonomy ladder will write to. v1.0
// wires the existing event surfaces (session create/update, vault ingest/
// delete, settings change). Later phases (research, proposer, workflow, apply
// pipeline) add their own appendAudit() calls without touching the chain
// machinery.
//
// Storage choice (vs SQLite / chain DB): append-only JSONL is the simplest
// tamper-evident store. fs.appendFile is POSIX-atomic for small writes (well
// under PIPE_BUF). Single-operator + single Next.js process means realistic
// concurrency is zero; multi-writer races accepted as v1.0 scope.

import { promises as fsp } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { argosRoot } from "./vault/paths";

export const AUDIT_VERSION = 1;

/**
 * Recognized audit event kinds. Adding a kind is non-breaking — readers
 * tolerate unknown kinds (they're still chain-valid). Use dot-separated
 * subject.verb form so future filters can group by subject.
 */
export type AuditKind =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "vault.ingested"
  | "vault.deleted"
  | "vault.auto-ingest"
  | "settings.changed"
  | "persona.switched"
  // Phase 5: voice I/O
  | "voice.transcribed"
  | "voice.spoken"
  // Reserved for later phases — declared here so the type is stable:
  | "research.fetched"
  | "memory.written"
  | "proposal.created"
  | "proposal.applied"
  | "proposal.rejected"
  | "workflow.executed";

/**
 * Single audit entry as persisted to JSONL. The `hash` field is the
 * sha256 of (prevHash + ":" + canonical-JSON-of-rest-of-entry), where
 * "rest of entry" excludes the `hash` field itself but includes prevHash.
 *
 * Canonical JSON = JSON.stringify with sorted keys at every nesting level.
 * Implemented in canonicalJson() below.
 */
export interface AuditEntry {
  version: number;
  index: number;        // monotonic from 0
  ts: number;           // unix epoch ms
  id: string;           // uuid4 sans dashes
  kind: AuditKind | string;  // string fallback for forward-compat
  sessionId?: string;   // session-scoped events
  payload: Record<string, unknown>;
  prevHash: string;     // hex sha256, "" for genesis
  hash: string;         // hex sha256, computed by appendAudit
}

// ----- paths -----

export function auditDir(): string {
  return path.join(argosRoot(), "state", "audit");
}

export function chainPath(): string {
  return path.join(auditDir(), "chain.jsonl");
}

// ----- canonical serialization -----

/**
 * Stable JSON serialization with sorted keys at every nesting level.
 * The hash MUST be computed over canonical bytes — otherwise a
 * cosmetic re-key (e.g. {b,a} vs {a,b}) would break the chain on
 * round-trip.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";  // matches JSON.stringify(undefined) behavior at top level
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Arrays preserve their order; undefined elements become null per
    // JSON.stringify spec.
    return (
      "[" +
      value
        .map((v) => (v === undefined ? "null" : canonicalJson(v)))
        .join(",") +
      "]"
    );
  }
  const obj = value as Record<string, unknown>;
  // CRITICAL: drop keys whose value is undefined. This matches
  // JSON.stringify's behavior — undefined values get omitted, not
  // serialized as "undefined". Without this, the hash computed at
  // write-time (with undefined sessionId in the object) differs from
  // the hash recomputed at read-time (where JSON.parse already dropped
  // the key) → chain verify fails on any entry with an optional field.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  return "{" + parts.join(",") + "}";
}

/**
 * Compute the hash for an entry: sha256( prevHash + ":" + canonicalJson(entryWithoutHash) ).
 * Exported so the verifier can use exactly the same function.
 */
export function computeEntryHash(entry: Omit<AuditEntry, "hash">): string {
  const canonical = canonicalJson(entry);
  return createHash("sha256")
    .update(entry.prevHash)
    .update(":")
    .update(canonical)
    .digest("hex");
}

// ----- read / append -----

async function ensureDir(): Promise<void> {
  await fsp.mkdir(auditDir(), { recursive: true });
}

// ----- tail cache (v1.1 optimization) ---------------------------
//
// Before v1.1: appendAudit() called readChain() to find prevHash,
// turning each append into O(n). At 10k entries this measured ~50 ms;
// at 100k ~500 ms. The chain itself only ever grows; once we've
// computed the tail we don't need to re-read the file unless the
// file changed out-of-band (concurrent writer, manual edit, restart).
//
// Strategy: cache { index, hash, mtimeMs, sizeBytes } in module
// scope. On every append, stat the file; if mtime + size match what
// we last saw, the cache is valid — single 1-byte appendFile write
// (no read). If anything differs, fall back to a full readChain()
// to rebuild the cache.
//
// Same file format on disk — fully backward compatible. Cache is
// pure speedup; correctness comes from the stat-based invalidation.
// Verified with multi-process scenarios in scripts/smoke-audit-chain.

interface TailCache {
  index: number;       // index of the cached tail entry (so next append is index+1)
  hash: string;        // hash of the cached tail entry (becomes next entry's prevHash)
  mtimeMs: number;     // file mtime when we last read it
  sizeBytes: number;   // file size when we last read it
}

let tailCache: TailCache | null = null;

async function statChain(): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try {
    const s = await fsp.stat(chainPath());
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Force-clear the tail cache. Test-only helper. */
export function _resetTailCache(): void {
  tailCache = null;
}

/**
 * Read all entries from the chain. Newer entries are at the end.
 * Empty array if chain doesn't exist yet (genesis case).
 *
 * Tolerates trailing whitespace and blank lines; skips malformed lines
 * with a console warning (does NOT break chain validity — that's the
 * verifier's job to flag).
 */
export async function readChain(): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(chainPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const lines = raw.split(/\r?\n/);
  const entries: AuditEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as AuditEntry;
      entries.push(parsed);
    } catch (parseErr) {
      console.warn(
        `[audit] skipping malformed chain line ${i + 1}: ${
          (parseErr as Error).message
        }`
      );
    }
  }
  return entries;
}

/**
 * Append a new audit entry. Computes index + prevHash + hash from the
 * current chain tail, persists to JSONL.
 *
 * v1.1: O(1) common-path via a stat-based tail cache. If the on-disk
 * file's mtime + size match what we cached last, we trust the cached
 * tail and skip the full read. Mismatch (concurrent writer, manual
 * edit, restart) triggers a fall-back full readChain() to rebuild.
 * Disk format unchanged.
 *
 * Returns the persisted entry (with `hash` populated).
 */
export async function appendAudit(
  kind: AuditKind | string,
  payload: Record<string, unknown>,
  opts: { sessionId?: string; ts?: number } = {}
): Promise<AuditEntry> {
  await ensureDir();

  // Tail resolution. Three cases:
  //   1. Cache miss (first append this process, or after _resetTailCache)
  //      → full readChain(), then warm the cache
  //   2. Cache hit + stat matches → use cached tail (O(1) — no read)
  //   3. Cache hit + stat mismatch → file changed under us; fall back
  //      to full readChain() + rewarm
  let prevHash: string;
  let nextIndex: number;
  const st = await statChain();

  if (
    tailCache !== null &&
    st !== null &&
    st.mtimeMs === tailCache.mtimeMs &&
    st.sizeBytes === tailCache.sizeBytes
  ) {
    // Case 2: O(1) fast path.
    prevHash = tailCache.hash;
    nextIndex = tailCache.index + 1;
  } else {
    // Case 1 or 3: rebuild.
    const existing = await readChain();
    const last = existing[existing.length - 1];
    prevHash = last?.hash ?? "";
    nextIndex = existing.length;
  }

  const entryWithoutHash: Omit<AuditEntry, "hash"> = {
    version: AUDIT_VERSION,
    index: nextIndex,
    ts: opts.ts ?? Date.now(),
    id: randomUUID().replace(/-/g, ""),
    kind,
    sessionId: opts.sessionId,
    payload,
    prevHash,
  };

  const hash = computeEntryHash(entryWithoutHash);
  const entry: AuditEntry = { ...entryWithoutHash, hash };

  // Append one JSONL line. Append-only + small payload + Node fsp.appendFile
  // → fine for single-operator concurrency.
  const line = JSON.stringify(entry) + "\n";
  await fsp.appendFile(chainPath(), line, "utf8");

  // Update the tail cache from our own stat post-write. If another
  // writer beats us to a subsequent write, the next append will
  // detect the mismatch + rebuild — no correctness loss, just one
  // cache miss.
  const afterStat = await statChain();
  if (afterStat !== null) {
    tailCache = {
      index: nextIndex,
      hash,
      mtimeMs: afterStat.mtimeMs,
      sizeBytes: afterStat.sizeBytes,
    };
  } else {
    // Stat failed post-write (unusual). Invalidate so next append
    // falls back to readChain.
    tailCache = null;
  }
  return entry;
}

// ----- verification -----

export interface ChainVerifyResult {
  ok: boolean;
  totalEntries: number;
  brokenAtIndex: number | null;  // first index where verification failed
  brokenReason: string | null;
  firstHash: string | null;
  lastHash: string | null;
}

/**
 * Walk the chain from genesis to tail. Each entry's `prevHash` must
 * equal the previous entry's `hash`. Each entry's `hash` must equal
 * computeEntryHash(entryWithoutHash). Genesis entry's `prevHash` must
 * be "".
 *
 * Returns the first break point + the reason. `ok: true` means
 * every entry verified.
 */
export async function verifyChain(): Promise<ChainVerifyResult> {
  const entries = await readChain();
  if (entries.length === 0) {
    return {
      ok: true,
      totalEntries: 0,
      brokenAtIndex: null,
      brokenReason: null,
      firstHash: null,
      lastHash: null,
    };
  }

  let prevHash = "";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.index !== i) {
      return {
        ok: false,
        totalEntries: entries.length,
        brokenAtIndex: i,
        brokenReason: `index mismatch: file position ${i} but entry.index = ${e.index}`,
        firstHash: entries[0].hash,
        lastHash: entries[entries.length - 1].hash,
      };
    }
    if (e.prevHash !== prevHash) {
      return {
        ok: false,
        totalEntries: entries.length,
        brokenAtIndex: i,
        brokenReason: `prevHash mismatch at index ${i}: expected ${prevHash || "<genesis>"} but entry.prevHash = ${e.prevHash || "<empty>"}`,
        firstHash: entries[0].hash,
        lastHash: entries[entries.length - 1].hash,
      };
    }
    // Recompute and verify the entry's own hash.
    const { hash: storedHash, ...rest } = e;
    const expected = computeEntryHash(rest);
    if (expected !== storedHash) {
      return {
        ok: false,
        totalEntries: entries.length,
        brokenAtIndex: i,
        brokenReason: `hash mismatch at index ${i}: stored ${storedHash} but recomputed ${expected} — payload tampered`,
        firstHash: entries[0].hash,
        lastHash: entries[entries.length - 1].hash,
      };
    }
    prevHash = storedHash;
  }

  return {
    ok: true,
    totalEntries: entries.length,
    brokenAtIndex: null,
    brokenReason: null,
    firstHash: entries[0].hash,
    lastHash: prevHash,
  };
}

// ----- session filtering -----

/**
 * Return only entries scoped to a given session id. Useful for the
 * /api/receipts endpoint and for the session-export bundle.
 */
export async function readSessionEntries(
  sessionId: string
): Promise<AuditEntry[]> {
  const all = await readChain();
  return all.filter((e) => e.sessionId === sessionId);
}
