// lib/memory/schema.ts
//
// Phase 9 — persistent memory schema. Types + constants only; zero
// logic. Pure import target for store/extractor/retriever and the
// memory API routes.
//
// Storage layout (all paths under argosRoot()/data/memory/):
//
//   data/memory/                  ← root
//   data/memory/SCHEMA_VERSION    ← single-byte header so first-boot
//                                   readers can detect schema drift
//   data/memory/{persona}/        ← per-persona subdir
//     short_term.jsonl
//     entity.jsonl
//     project.jsonl
//     operator_profile.jsonl       ← per-persona profile entries
//                                    (most personas won't use this;
//                                    the shared profile below is the
//                                    operator-canonical record)
//   data/memory/shared/
//     operator_profile.json        ← single-record shared profile
//                                    (not JSONL; whole-file rewrite)
//
// JSONL format: one JSON object per line, append-only. Schema_version
// is repeated on every entry so a future migration can decide per-row
// whether to upgrade. Tombstone pattern: pruned entries get a NEW
// JSONL line with `pruned: true` rather than physical deletion, so the
// audit chain over the data file stays unbroken. Readers filter
// pruned entries at read time.

export const MEMORY_SCHEMA_VERSION = 1;

/** Memory tiers per the Phase 9 directive. Tier 1 (session buffer) is
 *  in-memory only — it doesn't persist, doesn't have a tier here. The
 *  4 tiers below are the persisted ones. */
export type MemoryTier =
  | "short_term"
  | "entity"
  | "operator_profile"
  | "project";

/** All persistable tiers, in a stable iteration order matching the
 *  retrieval-priority order used by retriever.ts. */
export const ALL_TIERS: readonly MemoryTier[] = [
  "operator_profile",
  "short_term",
  "project",
  "entity",
] as const;

/** Persona scope for a memory entry. `"shared"` lets future cross-
 *  persona memories share a slot without inventing a new tier. The
 *  operator profile is special-cased into shared/. */
export type MemoryPersonaScope =
  | "bartimaeus"
  | "juniper"
  | "sage"
  | "bobby"
  | "shared";

/** How an entry was created. Used for filtering + audit display. */
export type MemorySource =
  | "conversation"     // extracted heuristically from a chat turn
  | "operator_explicit" // operator wrote it via /api/memory/write
  | "system";           // seeded (e.g. initial operator profile)

/**
 * A single persisted memory entry. The `audit_hash` field forms a
 * per-(persona,tier) hash chain — each entry's hash is
 * sha256(prev_audit_hash + ":" + canonicalJson(entry-without-audit_hash))
 * matching the lib/audit.ts pattern. Same primitive, narrower scope:
 * the global audit chain at state/audit/chain.jsonl is the truth
 * surface; the per-file hash chain inside the JSONL is integrity
 * insurance against silent file edits.
 */
export interface MemoryEntry {
  /** uuid4 without dashes, matches audit entry id format. */
  id: string;
  /** Set from MEMORY_SCHEMA_VERSION at write time; preserved on read. */
  schema_version: number;
  tier: MemoryTier;
  persona_id: MemoryPersonaScope;
  /** ISO 8601 (e.g. "2026-05-27T13:45:01.234Z"). */
  created_at: string;
  /** ISO 8601 — equals created_at on first write, updated on tombstone. */
  updated_at: string;
  /** The actual memory text. Plain prose; not formatted. */
  content: string;
  /** Provenance (heuristic / explicit / system). */
  source: MemorySource;
  /** Retrieval ranking 0.0-1.0. Higher = more important. */
  importance: number;
  /** Free-form labels for tag-search. Conventions:
   *   "operator", "project:argos", "entity:jabor", "preference",
   *   "pii"… readers can filter on substring. */
  tags: string[];
  /** Tombstone flag. Pruned entries are not physically deleted; they
   *  get a new line with pruned:true so the on-disk hash chain
   *  remains verifiable. Readers filter pruned at read time. */
  pruned: boolean;
  /** Per-file hash chain anchor. See top-of-file commentary. */
  audit_hash: string;
}

/**
 * Operator profile — the canonical "who is the operator?" record,
 * shared across all personas. Stored as a single JSON object at
 * data/memory/shared/operator_profile.json (overwritten in place
 * via atomic temp+rename on each update). Mutated rarely.
 *
 * Why not a JSONL of profile-entries: profile is small + always
 * read as a whole; we don't need a per-edit history (the audit chain
 * already captures every profile change). Simpler API for the UI.
 */
export interface OperatorProfile {
  name: string;
  role: string;
  context: string;
  preferences: Record<string, string>;
  /** ISO 8601 timestamp of last write. */
  last_updated: string;
}

/** Default empty profile, used when no file exists yet. Distinct from
 *  `null` returned by getOperatorProfile() — `null` means "no profile
 *  has ever been seeded"; this constant is the shape if you ever
 *  need an empty form to render. */
export const EMPTY_OPERATOR_PROFILE: OperatorProfile = {
  name: "",
  role: "",
  context: "",
  preferences: {},
  last_updated: "",
};

/** Type guard for runtime input from the operator-write endpoint. */
export function isMemoryTier(v: unknown): v is MemoryTier {
  return (
    typeof v === "string" &&
    (v === "short_term" ||
      v === "entity" ||
      v === "operator_profile" ||
      v === "project")
  );
}

export function isMemoryPersonaScope(v: unknown): v is MemoryPersonaScope {
  return (
    typeof v === "string" &&
    (v === "bartimaeus" ||
      v === "juniper" ||
      v === "sage" ||
      v === "bobby" ||
      v === "shared")
  );
}
