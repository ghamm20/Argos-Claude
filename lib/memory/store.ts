// lib/memory/store.ts
//
// Phase 9 — memory persistence layer. JSONL on disk, hash-chained
// per file, audit-logged to the global chain via lib/audit.ts.
//
// Design choices:
//   - Per-(persona,tier) JSONL files. Tombstone-only deletion.
//   - Per-file hash chain (audit_hash) chained to its previous line in
//     the SAME file. Independent from the global audit chain (which
//     also records every write) — two layers of tamper-evidence.
//   - All writes route through the global appendAudit() so the
//     persistent-state changes are visible in /api/receipts and
//     surveyor-discoverable.
//   - Pure Node stdlib (fs/promises, crypto, path). No new deps.
//   - Path root = argosRoot()/data/memory by default, overridable
//     via ARGOS_DATA_DIR env. USB-native: same launcher cwd as the
//     rest of the state tree.
//
// Concurrency: single-operator + single Next.js process; assumed
// serial. The same assumption that lib/audit.ts makes. If multi-
// writer becomes a real scenario we'd add advisory locks; out of
// Phase 9 scope.

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import {
  appendAudit,
  canonicalJson,
} from "../audit";
import {
  MEMORY_SCHEMA_VERSION,
  ALL_TIERS,
  EMPTY_OPERATOR_PROFILE,
  type MemoryEntry,
  type MemoryTier,
  type MemoryPersonaScope,
  type OperatorProfile,
} from "./schema";

// ----- paths -----

/** Memory data root. ARGOS_DATA_DIR overrides; otherwise tucks under
 *  argosRoot() so smokes and the operator's USB use the same tree. */
export function memoryDir(): string {
  if (process.env.ARGOS_DATA_DIR && process.env.ARGOS_DATA_DIR.length > 0) {
    return path.join(process.env.ARGOS_DATA_DIR, "memory");
  }
  return path.join(argosRoot(), "data", "memory");
}

/** Schema version sentinel — single-line text file. First-boot writers
 *  create it; future migrations read it to decide what to do. */
function schemaVersionPath(): string {
  return path.join(memoryDir(), "SCHEMA_VERSION");
}

function personaDir(personaId: MemoryPersonaScope): string {
  return path.join(memoryDir(), personaId);
}

function tierFilePath(personaId: MemoryPersonaScope, tier: MemoryTier): string {
  return path.join(personaDir(personaId), `${tier}.jsonl`);
}

function sharedDir(): string {
  return path.join(memoryDir(), "shared");
}

function operatorProfilePath(): string {
  return path.join(sharedDir(), "operator_profile.json");
}

// ----- init -----

let initRan = false;

/**
 * Create the memory directory tree + schema version sentinel on first
 * run. Idempotent — safe to call many times. Self-disables after the
 * first successful pass via the module-scope `initRan` flag.
 *
 * Doesn't seed any data — that's the operator's or seed script's job.
 */
export async function initMemoryStore(): Promise<void> {
  if (initRan) return;
  await fsp.mkdir(memoryDir(), { recursive: true });
  await fsp.mkdir(sharedDir(), { recursive: true });
  for (const p of [
    "bartimaeus",
    "juniper",
    "sage",
    "bobby",
    "shared",
  ] as MemoryPersonaScope[]) {
    await fsp.mkdir(personaDir(p), { recursive: true });
  }
  if (!existsSync(schemaVersionPath())) {
    await fsp.writeFile(
      schemaVersionPath(),
      String(MEMORY_SCHEMA_VERSION) + "\n",
      "utf8"
    );
  }
  initRan = true;
}

// ----- per-file hash chain helpers -----

/**
 * Compute audit_hash for one entry. sha256(prev_hash + ":" +
 * canonicalJson(entry-without-audit_hash)). Same primitive used by
 * lib/audit.ts (canonicalJson imported from there for consistency).
 */
function computeEntryAuditHash(
  prevHash: string,
  entryWithoutHash: Omit<MemoryEntry, "audit_hash">
): string {
  const canonical = canonicalJson(entryWithoutHash);
  return createHash("sha256")
    .update(prevHash)
    .update(":")
    .update(canonical)
    .digest("hex");
}

/**
 * Read every line of a JSONL file and return parsed entries. Malformed
 * lines are skipped with a warning — never throws on parse errors;
 * memory must degrade gracefully (an unreadable file just means
 * "no memories of this kind", not a crash).
 *
 * Returns [] if the file doesn't exist.
 */
async function readJsonlFile(filePath: string): Promise<MemoryEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: MemoryEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as MemoryEntry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[memory] skipping malformed line ${i + 1} in ${filePath}: ${
          (err as Error).message
        }`
      );
    }
  }
  return out;
}

/** Get the tail audit_hash of a JSONL file. Empty string if file is
 *  empty or missing — genesis case for the per-file chain. */
async function tailHash(filePath: string): Promise<string> {
  const entries = await readJsonlFile(filePath);
  if (entries.length === 0) return "";
  return entries[entries.length - 1].audit_hash ?? "";
}

// ----- write -----

/**
 * Append a new memory entry. Caller provides everything except the
 * computed fields (id, audit_hash, schema_version). We:
 *
 *   1. Ensure the persona dir exists
 *   2. Read the file's current tail to find the previous audit_hash
 *   3. Build the complete entry with id + schema_version + audit_hash
 *   4. Append one JSONL line
 *   5. Log to the global audit chain as kind "memory.written"
 *
 * Returns the persisted entry. Throws on disk I/O errors — caller is
 * expected to wrap in try/catch and degrade gracefully (memory must
 * never break chat).
 */
export async function writeMemory(
  partial: Omit<MemoryEntry, "id" | "audit_hash" | "schema_version">
): Promise<MemoryEntry> {
  await initMemoryStore();
  const dir = personaDir(partial.persona_id);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = tierFilePath(partial.persona_id, partial.tier);
  const prevHash = await tailHash(filePath);

  const id = randomUUID().replace(/-/g, "");
  const entryWithoutHash: Omit<MemoryEntry, "audit_hash"> = {
    id,
    schema_version: MEMORY_SCHEMA_VERSION,
    ...partial,
  };
  const audit_hash = computeEntryAuditHash(prevHash, entryWithoutHash);
  const entry: MemoryEntry = { ...entryWithoutHash, audit_hash };

  await fsp.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");

  // Best-effort global audit log. If the audit chain itself is broken
  // we still want the memory write to succeed (the JSONL file is the
  // authoritative store; audit is the receipt). Same posture as
  // lib/settings.ts.
  try {
    await appendAudit("memory.written", {
      memoryId: entry.id,
      tier: entry.tier,
      personaId: entry.persona_id,
      source: entry.source,
      importance: entry.importance,
      tagCount: entry.tags.length,
      // Hash chained to the per-file chain for cross-reference. The
      // global audit chain's own hash is independent.
      perFileAuditHash: entry.audit_hash,
    });
  } catch (auditErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[memory] audit append failed (non-fatal): ${
        (auditErr as Error).message
      }`
    );
  }

  return entry;
}

// ----- read -----

/**
 * All non-pruned entries for a persona+tier, sorted by importance
 * descending, created_at descending (newer first within same score).
 *
 * Note: pruned entries are filtered AT READ TIME. The on-disk file
 * keeps every prune-tombstone line so the per-file hash chain stays
 * verifiable end-to-end.
 *
 * If the tombstone-vs-original logic gets richer (e.g. "show last
 * N pruned"), the read pipeline is where it lives — disk format
 * stays append-only.
 */
export async function readMemories(
  personaId: MemoryPersonaScope,
  tier: MemoryTier,
  limit?: number
): Promise<MemoryEntry[]> {
  const filePath = tierFilePath(personaId, tier);
  const raw = await readJsonlFile(filePath);

  // Group by id; the LATEST entry with that id wins (so a tombstone
  // line for an existing id overrides the original). Then drop pruned.
  const latestById = new Map<string, MemoryEntry>();
  for (const e of raw) {
    latestById.set(e.id, e);
  }
  const live = Array.from(latestById.values()).filter((e) => !e.pruned);

  live.sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.created_at.localeCompare(a.created_at);
  });

  return typeof limit === "number" && limit > 0
    ? live.slice(0, limit)
    : live;
}

/** Read every non-pruned entry for a persona across all tiers. Useful
 *  for the Memory page UI and for full-persona inspection. */
export async function readAllMemories(
  personaId: MemoryPersonaScope
): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (const tier of ALL_TIERS) {
    const tierEntries = await readMemories(personaId, tier);
    out.push(...tierEntries);
  }
  // Stable cross-tier sort: importance desc, then created_at desc.
  out.sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.created_at.localeCompare(a.created_at);
  });
  return out;
}

// ----- prune (tombstone) -----

/**
 * Tombstone an entry by id. Searches every persona+tier file for the
 * id, appends a new line that copies the entry with pruned:true and
 * a refreshed updated_at + new audit_hash chained from the file's
 * current tail.
 *
 * Idempotent: pruning an already-pruned entry is a no-op (we read
 * the latest-by-id, see pruned:true, write nothing). Returns silently
 * if the id isn't found anywhere — same posture as DELETE in REST
 * (no error on idempotent absence).
 */
export async function pruneMemory(entryId: string): Promise<void> {
  await initMemoryStore();
  for (const persona of [
    "bartimaeus",
    "juniper",
    "sage",
    "bobby",
    "shared",
  ] as MemoryPersonaScope[]) {
    for (const tier of ALL_TIERS) {
      const filePath = tierFilePath(persona, tier);
      const raw = await readJsonlFile(filePath);
      // Find the latest line for this id (so we tombstone the current
      // version, not a stale one).
      let latest: MemoryEntry | null = null;
      for (const e of raw) {
        if (e.id === entryId) latest = e;
      }
      if (!latest || latest.pruned) continue;

      const prevHash = await tailHash(filePath);
      const tombstoneWithoutHash: Omit<MemoryEntry, "audit_hash"> = {
        ...latest,
        pruned: true,
        updated_at: new Date().toISOString(),
      };
      const audit_hash = computeEntryAuditHash(prevHash, tombstoneWithoutHash);
      const tombstone: MemoryEntry = { ...tombstoneWithoutHash, audit_hash };
      await fsp.appendFile(filePath, JSON.stringify(tombstone) + "\n", "utf8");

      try {
        await appendAudit("memory.written", {
          memoryId: tombstone.id,
          tier: tombstone.tier,
          personaId: tombstone.persona_id,
          source: tombstone.source,
          pruned: true,
          perFileAuditHash: tombstone.audit_hash,
        });
      } catch (auditErr) {
        // eslint-disable-next-line no-console
        console.warn(
          `[memory] prune audit append failed (non-fatal): ${
            (auditErr as Error).message
          }`
        );
      }
      return;
    }
  }
  // id not found anywhere — silent success (idempotent).
}

// ----- tag search -----

/**
 * All non-pruned entries for a persona where ANY tag matches the
 * supplied tag (case-insensitive). Substring match: searching "argos"
 * matches both "project:argos" and "argos-host".
 */
export async function searchMemoriesByTag(
  personaId: MemoryPersonaScope,
  tag: string
): Promise<MemoryEntry[]> {
  const needle = tag.toLowerCase();
  const all = await readAllMemories(personaId);
  return all.filter((e) =>
    e.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

// ----- operator profile -----

/**
 * Read the shared operator profile. Returns null if no profile has
 * ever been written (caller decides whether to seed or to render an
 * empty form).
 */
export async function getOperatorProfile(): Promise<OperatorProfile | null> {
  await initMemoryStore();
  try {
    const raw = await fsp.readFile(operatorProfilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OperatorProfile>;
    return {
      ...EMPTY_OPERATOR_PROFILE,
      ...parsed,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Write/merge the operator profile. Partial updates are merged into
 * the existing profile (preserves fields the caller didn't touch).
 * Atomic write via temp+rename so a yanked USB mid-write can't leave
 * the file half-written.
 *
 * Audit-logs every write as "memory.written" with tier:operator_profile
 * so the global chain captures every profile change.
 */
export async function writeOperatorProfile(
  patch: Partial<OperatorProfile>
): Promise<OperatorProfile> {
  await initMemoryStore();
  await fsp.mkdir(sharedDir(), { recursive: true });
  const existing = (await getOperatorProfile()) ?? EMPTY_OPERATOR_PROFILE;
  const next: OperatorProfile = {
    ...existing,
    ...patch,
    preferences: {
      ...existing.preferences,
      ...(patch.preferences ?? {}),
    },
    last_updated: new Date().toISOString(),
  };
  const finalPath = operatorProfilePath();
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const payload = JSON.stringify(next, null, 2);
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(payload, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmpPath, finalPath);

  try {
    await appendAudit("memory.written", {
      memoryId: "operator_profile",
      tier: "operator_profile" as MemoryTier,
      personaId: "shared" as MemoryPersonaScope,
      source: "operator_explicit",
      changedKeys: Object.keys(patch),
    });
  } catch (auditErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[memory] operator profile audit append failed (non-fatal): ${
        (auditErr as Error).message
      }`
    );
  }

  return next;
}
