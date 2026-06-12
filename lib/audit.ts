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
// under PIPE_BUF).
//
// CONCURRENCY (corrected 2026-06-12, owner chain ruling): realistic
// concurrency is NOT zero. A single Next.js process runs concurrent async
// handlers, and two appendAudit() calls awaiting in the same tick (observed:
// memory.written racing session.created/updated) both read the same tail and
// both write the same index + prevHash — a chain FORK. The live deploy chain
// carries three such forks (indices 62, 208, 262; same-millisecond sibling
// pairs, all content-verified). appendAudit is therefore MUTEX-SERIALIZED
// in-process below. Forked history is never re-chained — forks are documented
// FORWARD via a "chain.fork_annotated" entry, and verifyChain() treats
// annotated + content-verified forks as GREEN-with-noted-forks. Cross-process
// races remain theoretically possible but the daemon-lifecycle doctrine
// (one server process) keeps them out of scope.

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
  // Phase 8 (2026-06-10) — vault self-heal: manifest rebuilt from chunks
  // after a missing/corrupt manifest (silent-loss recovery, never silent).
  | "vault.manifest_recovered"
  // Phase 9 rider (2026-06-10) — self-heal trust boundary: a chunk that fails
  // provenance/hash verification at heal is quarantined, not indexed; and the
  // provenance-less fallback (legacy/copied vault) is recorded.
  | "vault.chunk_quarantined"
  | "vault.heal_unverified"
  // Owner chain ruling (2026-06-12) — a forward annotation documenting one or
  // more historical chain forks (duplicate index + prevHash from a concurrent-
  // writer race). History is NEVER re-chained; the annotation is the durable
  // record the verifier matches against. See verifyChain().
  | "chain.fork_annotated"
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
  // Phase 5 rider — the scheduled nightly proposer pass (proposals only).
  | "proposal.scheduled_pass"
  | "workflow.executed"
  // Phase 5 (2026-06-10) — workflow engine lifecycle.
  | "workflow.created"
  | "workflow.step"
  | "workflow.halted"
  | "workflow.resumed"
  | "workflow.completed"
  | "workflow.aborted"
  // Phase 3 (2026-06-10) — overnight engine: every task action is chained.
  | "task.claimed"
  | "task.step"
  | "task.completed"
  | "task.failed"
  | "task.preflight"
  // Phase 7 (2026-06-10) — operator Power-Mode override + honest attempt-on failure.
  | "gpu.power_override"
  | "gpu.power_attempt_failed";

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
 * v1.1 — lightweight chain entry count. Uses the tail cache for O(1)
 * common-case; falls back to streaming line count if cache cold or
 * file changed under us. Never deserializes JSON. Safe for HUD polls.
 *
 * Returns 0 if the chain file doesn't exist yet (genesis case).
 */
export async function getChainCount(): Promise<number> {
  const st = await statChain();
  if (st === null) return 0;
  if (
    tailCache !== null &&
    st.mtimeMs === tailCache.mtimeMs &&
    st.sizeBytes === tailCache.sizeBytes
  ) {
    // Cache hit: tail entry index N → chain has N+1 entries.
    return tailCache.index + 1;
  }
  // Cache miss — stream-count newlines. No JSON parse; one read.
  const raw = await fsp.readFile(chainPath(), "utf8");
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10 /* \n */) count++;
  }
  // Trailing-non-newline edge: if last line has content but no \n,
  // it still counts as one entry. Append always writes "...\n" so
  // this is defensive-only.
  if (raw.length > 0 && raw.charCodeAt(raw.length - 1) !== 10) count++;
  return count;
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

// In-process append mutex (owner chain ruling, 2026-06-12). Serializes the
// read-tail → hash → write critical section so two concurrent handlers can
// never both extend the same tail (the fork mechanism behind live indices
// 62/208/262). A failed append must not poison the queue — the chain link
// swallows, the caller still sees the rejection.
let appendQueue: Promise<unknown> = Promise.resolve();

/**
 * Append a new audit entry. Computes index + prevHash + hash from the
 * current chain tail, persists to JSONL.
 *
 * MUTEX-SERIALIZED in-process: concurrent calls queue and run one at a
 * time (see appendQueue above).
 *
 * v1.1: O(1) common-path via a stat-based tail cache. If the on-disk
 * file's mtime + size match what we cached last, we trust the cached
 * tail and skip the full read. Mismatch (concurrent writer, manual
 * edit, restart) triggers a fall-back full readChain() to rebuild.
 * Disk format unchanged.
 *
 * Returns the persisted entry (with `hash` populated).
 */
export function appendAudit(
  kind: AuditKind | string,
  payload: Record<string, unknown>,
  opts: { sessionId?: string; ts?: number } = {}
): Promise<AuditEntry> {
  const run = appendQueue.then(() => appendAuditUnlocked(kind, payload, opts));
  appendQueue = run.catch(() => {
    /* keep the queue alive past a failed append */
  });
  return run;
}

async function appendAuditUnlocked(
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

/** A detected fork: two (or more) sibling entries sharing the same index and
 *  the same prevHash — the signature of a concurrent-writer race. */
export interface ChainFork {
  /** entry.index shared by the sibling entries */
  index: number;
  /** file positions (0-based line numbers) of the sibling entries */
  positions: number[];
  /** hashes of every sibling branch tip, in file order */
  branchHashes: string[];
  /** whether a chain.fork_annotated entry documents this fork */
  annotated: boolean;
}

export type ChainVerifyStatus = "GREEN" | "GREEN_WITH_NOTED_FORKS" | "FAIL";

export interface ChainVerifyResult {
  ok: boolean;
  /** GREEN = clean linear chain. GREEN_WITH_NOTED_FORKS = every entry
   *  content-verified AND every fork documented by a chain.fork_annotated
   *  entry (owner ruling 2026-06-12). FAIL = tampered content, an
   *  unannotated break, or a non-fork linkage anomaly — lockdown-trigger
   *  class. */
  status: ChainVerifyStatus;
  totalEntries: number;
  brokenAtIndex: number | null;  // first index where verification failed
  brokenReason: string | null;
  firstHash: string | null;
  lastHash: string | null;
  /** every detected fork (empty for a clean chain) */
  forks: ChainFork[];
}

/**
 * Walk the chain from genesis to tail. Each entry's `hash` must equal
 * computeEntryHash(entryWithoutHash) — a content-hash mismatch is ALWAYS a
 * hard FAIL (tamper). Linkage: each entry's `prevHash` must equal the
 * previous entry's `hash` and its index must increment — EXCEPT at a fork,
 * where a sibling entry repeats the previous entry's index AND prevHash
 * (two writers raced the same tail), and the entry after the fork group may
 * chain from ANY sibling branch tip.
 *
 * Owner ruling (2026-06-12): a fork whose siblings all content-verify AND
 * which is documented by a later `chain.fork_annotated` entry (payload
 * .forks[] item matching index + the full branch-hash set) is tolerated —
 * result ok:true, status GREEN_WITH_NOTED_FORKS. An UNANNOTATED fork, a
 * content-hash mismatch, or any other linkage break stays a hard FAIL
 * (lockdown-trigger class). History is never re-chained.
 */
export async function verifyChain(): Promise<ChainVerifyResult> {
  const entries = await readChain();
  if (entries.length === 0) {
    return {
      ok: true,
      status: "GREEN",
      totalEntries: 0,
      brokenAtIndex: null,
      brokenReason: null,
      firstHash: null,
      lastHash: null,
      forks: [],
    };
  }

  const fail = (i: number, reason: string): ChainVerifyResult => ({
    ok: false,
    status: "FAIL",
    totalEntries: entries.length,
    brokenAtIndex: i,
    brokenReason: reason,
    firstHash: entries[0].hash,
    lastHash: entries[entries.length - 1].hash,
    forks: [],
  });

  // Pass 1 — content integrity. Every entry's own hash must recompute.
  // Tamper anywhere is a hard FAIL regardless of annotations.
  for (let i = 0; i < entries.length; i++) {
    const { hash: storedHash, ...rest } = entries[i];
    const expected = computeEntryHash(rest);
    if (expected !== storedHash) {
      return fail(
        i,
        `hash mismatch at position ${i} (index ${entries[i].index}): stored ${storedHash} but recomputed ${expected} — payload tampered`
      );
    }
  }

  // Collect fork annotations (any position — annotations always land AFTER
  // the forks they document, but matching is by content, not order).
  const annotatedForks: Array<{ index: number; branchHashes: string[] }> = [];
  for (const e of entries) {
    if (e.kind !== "chain.fork_annotated") continue;
    const list = (e.payload as { forks?: unknown }).forks;
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const idx = (f as { index?: unknown }).index;
      const hashes = (f as { branchHashes?: unknown }).branchHashes;
      if (typeof idx === "number" && Array.isArray(hashes)) {
        annotatedForks.push({
          index: idx,
          branchHashes: hashes.filter((h): h is string => typeof h === "string"),
        });
      }
    }
  }
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

  // Pass 2 — linkage walk with fork tolerance.
  if (entries[0].prevHash !== "" || entries[0].index !== 0) {
    return fail(0, `genesis entry must have index 0 and empty prevHash`);
  }
  const forks: ChainFork[] = [];
  // Branch tips an entry may legally chain from. Normally one (the previous
  // entry's hash); immediately after a fork group, every sibling tip.
  let tips = new Set<string>([entries[0].hash]);
  let prev = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash === prev.prevHash && e.index === prev.index) {
      // Fork sibling: raced the same tail as `prev`. Extend (or open) the
      // fork group at this index.
      const open = forks.find(
        (f) => f.index === e.index && f.positions.includes(i - 1)
      );
      if (open) {
        open.positions.push(i);
        open.branchHashes.push(e.hash);
      } else {
        forks.push({
          index: e.index,
          positions: [i - 1, i],
          branchHashes: [prev.hash, e.hash],
          annotated: false,
        });
      }
      tips.add(e.hash);
      prev = e;
      continue;
    }
    if (tips.has(e.prevHash) && (e.index === prev.index + 1 || e.index === i)) {
      // Normal continuation — from the single tip, or from any sibling
      // branch tip right after a fork group. `e.index === i` tolerates the
      // post-fork index RE-SYNC: a fork makes file position run ahead of
      // entry.index; a writer that rebuilt its tail via readChain() assigns
      // index = file position, skipping one index value per prior fork
      // (live chain: 67, 219, 283 are bookkeeping holes, not deletions —
      // the unbroken prevHash linkage proves no entry was removed).
      tips = new Set([e.hash]);
      prev = e;
      continue;
    }
    return fail(
      i,
      `prevHash mismatch at position ${i} (index ${e.index}): expected one of [${[...tips].map((h) => h.slice(0, 12)).join(", ")}] but entry.prevHash = ${(e.prevHash || "<empty>").slice(0, 12)}`
    );
  }

  // Pass 3 — every detected fork must be annotated (index + full branch set).
  for (const f of forks) {
    f.annotated = annotatedForks.some(
      (a) => a.index === f.index && sameSet(a.branchHashes, f.branchHashes)
    );
    if (!f.annotated) {
      return {
        ...fail(
          f.index,
          `UNANNOTATED chain fork at index ${f.index} (positions ${f.positions.join("/")}) — lockdown-trigger class; append a chain.fork_annotated entry documenting it or treat as tamper`
        ),
        forks,
      };
    }
  }

  return {
    ok: true,
    status: forks.length > 0 ? "GREEN_WITH_NOTED_FORKS" : "GREEN",
    totalEntries: entries.length,
    brokenAtIndex: null,
    brokenReason: null,
    firstHash: entries[0].hash,
    lastHash: prev.hash,
    forks,
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
