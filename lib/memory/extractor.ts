// lib/memory/extractor.ts
//
// Phase 9 — memory extraction heuristics.
//
// Given a completed conversation turn, return 0..N memory candidates
// the caller should writeMemory() for. Deliberately deterministic —
// no LLM round-trip, no async outside reading the profile we were
// passed. Cheap, fast, predictable.
//
// Five heuristics per the Phase 9 directive:
//
//   1. Operator name/role        ("I am", "I'm", "my name is", "I work as")
//                                 → tier: operator_profile, importance 0.8
//   2. Project reference         (named projects: ARGOS, Jenna, Parascope,
//                                 Sentry, Cortex, Halal Jordan)
//                                 → tier: project, importance 0.7
//   3. Named entity              (Capitalized multi-word phrase not already
//                                 a project; small whitelist of personal
//                                 names too)
//                                 → tier: entity, importance 0.6
//   4. Operator preference       ("I prefer", "I want", "always", "never",
//                                 "I like")
//                                 → tier: operator_profile, importance 0.8
//   5. Explicit memory request   ("remember that", "don't forget", "note that")
//                                 → tier: short_term, importance 0.9
//
// Each heuristic runs independently. Multiple heuristics MAY fire on
// the same turn — extractor returns the union. Caller decides dedup
// (none required for v1: same content with different tier is fine).

import type {
  MemoryEntry,
  MemoryPersonaScope,
  MemorySource,
  OperatorProfile,
} from "./schema";

/** Candidate emitted by an extractor. Caller adds id/audit_hash/
 *  schema_version at writeMemory time. */
type Candidate = Omit<MemoryEntry, "id" | "audit_hash" | "schema_version">;

// Known projects. The directive's list — locked. Tag form is
// "project:<lowercase>" so the retriever can match on substring.
// `id` field intentional: future Phase 9B might want to map back from
// tag → display name; pattern keeps both side-by-side.
const KNOWN_PROJECTS: { id: string; display: string; aliases: string[] }[] = [
  { id: "argos", display: "ARGOS", aliases: ["argos"] },
  { id: "jenna", display: "Jenna", aliases: ["jenna"] },
  { id: "parascope", display: "Parascope", aliases: ["parascope"] },
  { id: "sentry", display: "Sentry", aliases: ["sentry"] },
  { id: "cortex", display: "Cortex", aliases: ["cortex"] },
  {
    id: "halal-jordan",
    display: "Halal Jordan",
    aliases: ["halal jordan", "halaljordan"],
  },
];

// Lightweight stopword set for entity detection — Capitalized words
// at sentence starts are too noisy without a filter. List intentionally
// kept short; the entity heuristic is permissive by design and the
// retriever's importance-based ranking does the second-pass culling.
const ENTITY_STOPWORDS = new Set<string>([
  "I",
  "I'm",
  "I've",
  "I'll",
  "I'd",
  "The",
  "A",
  "An",
  "This",
  "That",
  "These",
  "Those",
  "When",
  "Where",
  "What",
  "Who",
  "Why",
  "How",
  "Yes",
  "No",
  "Maybe",
  "OK",
  "Okay",
  "But",
  "And",
  "Or",
  "So",
  "Then",
  "Now",
  "Today",
  "Tomorrow",
  "Yesterday",
  "Mr",
  "Mrs",
  "Ms",
  "Dr",
  // Persona names themselves should not auto-create entity memories
  // about themselves.
  "Bartimaeus",
  "Juniper",
  "Sage",
  "Bobby",
  "Operator",
  "Djinn",
]);

// ----- helpers -----

function nowIso(): string {
  return new Date().toISOString();
}

/** Truncate a candidate's content to a reasonable upper bound — no
 *  point storing an entire conversation turn as a single "memory". */
function clip(text: string, max = 480): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/** Lowercased + non-word-stripped for substring matching. */
function lower(s: string): string {
  return s.toLowerCase();
}

// ----- heuristic 1: operator name / role detection -----
//
// Examples that match:
//   "I am Gordy."
//   "I'm the COO of EKG Security."
//   "My name is Gordon Tarlton."
//   "I work as a security executive."
//
// Captures the predicate phrase that follows. Doesn't attempt to
// parse the role into structured fields — just stores the operator's
// own statement verbatim (clipped).
function extractOperatorIdentity(
  userMessage: string,
  personaId: MemoryPersonaScope,
  source: MemorySource
): Candidate[] {
  const m = userMessage.match(
    /\b(?:I am|I'm|my name is|I work as|I serve as|I run|I lead)\b\s+(.{3,200}?)(?:[.!?\n]|$)/i
  );
  if (!m) return [];
  const predicate = m[1].trim();
  if (!predicate) return [];
  // Filter out trivial / off-topic matches ("I'm fine", "I'm here", etc.)
  const trivial = /^(?:fine|good|ok|okay|here|sorry|back|busy|tired|done)$/i;
  if (trivial.test(predicate)) return [];

  return [
    {
      tier: "operator_profile",
      persona_id: personaId,
      created_at: nowIso(),
      updated_at: nowIso(),
      content: clip(`Operator self-described: ${predicate}`),
      source,
      importance: 0.8,
      tags: ["operator", "identity"],
      pruned: false,
    },
  ];
}

// ----- heuristic 2: project reference -----

function extractProjectReferences(
  userMessage: string,
  assistantResponse: string,
  personaId: MemoryPersonaScope,
  source: MemorySource
): Candidate[] {
  const combined = `${userMessage}\n${assistantResponse}`;
  const lc = lower(combined);
  const out: Candidate[] = [];
  for (const proj of KNOWN_PROJECTS) {
    const hit = proj.aliases.some((a) => {
      // Match as a whole word — "argos" matches but "argosaurus" doesn't.
      const re = new RegExp(`\\b${a.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
      return re.test(lc);
    });
    if (!hit) continue;
    // Try to capture a sentence containing the project name from the
    // user message; fall back to assistant response. Stores ONE
    // candidate per project per turn.
    const allSentences = combined.split(/(?<=[.!?])\s+/);
    const sentence =
      allSentences.find((s) =>
        proj.aliases.some((a) =>
          new RegExp(`\\b${a.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(s)
        )
      ) || `Reference to ${proj.display}.`;
    out.push({
      tier: "project",
      persona_id: personaId,
      created_at: nowIso(),
      updated_at: nowIso(),
      content: clip(sentence),
      source,
      importance: 0.7,
      tags: [`project:${proj.id}`, "project"],
      pruned: false,
    });
  }
  return out;
}

// ----- heuristic 3: named entity -----
//
// Matches capitalized multi-word phrases AND single-word names not
// in the stopword list, in the user message only (assistant responses
// frequently include capitalized terms that aren't operator-relevant).
// Deduplicates and skips entities that overlap a project name (the
// project heuristic already captured them).
function extractNamedEntities(
  userMessage: string,
  personaId: MemoryPersonaScope,
  source: MemorySource
): Candidate[] {
  // Capture sequences of 1+ capitalized words. Tolerates apostrophes
  // and hyphens (so "O'Brien" and "Sub-Saharan" survive).
  const re = /\b([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,3})\b/g;
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(userMessage)) !== null) {
    const phrase = m[1].trim();
    if (!phrase) continue;
    if (seen.has(phrase.toLowerCase())) continue;
    seen.add(phrase.toLowerCase());
    // Skip single-word stopwords and stopword-only multi-word phrases.
    const words = phrase.split(/\s+/);
    if (words.every((w) => ENTITY_STOPWORDS.has(w))) continue;
    if (words.length === 1 && ENTITY_STOPWORDS.has(words[0])) continue;
    // Skip if matches a known project (project heuristic owns it).
    const lcPhrase = lower(phrase);
    if (
      KNOWN_PROJECTS.some((p) =>
        p.aliases.some((a) => lcPhrase === a || lcPhrase.includes(a))
      )
    )
      continue;
    // Skip if at the very start of the message AND a single word —
    // sentence-start capitalization noise.
    if (words.length === 1 && userMessage.trim().startsWith(phrase)) continue;

    const tagSlug = lcPhrase.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    out.push({
      tier: "entity",
      persona_id: personaId,
      created_at: nowIso(),
      updated_at: nowIso(),
      content: clip(`Operator mentioned: ${phrase}`),
      source,
      importance: 0.6,
      tags: [`entity:${tagSlug}`, "entity"],
      pruned: false,
    });
    // Cap at 3 entities per turn to avoid runaway extraction on
    // proper-noun-heavy messages.
    if (out.length >= 3) break;
  }
  return out;
}

// ----- heuristic 4: operator preference -----

function extractPreferences(
  userMessage: string,
  personaId: MemoryPersonaScope,
  source: MemorySource
): Candidate[] {
  const patterns = [
    /\bI prefer\b\s+(.{3,200}?)(?:[.!?\n]|$)/i,
    /\bI want\b\s+(.{3,200}?)(?:[.!?\n]|$)/i,
    /\bI like\b\s+(.{3,200}?)(?:[.!?\n]|$)/i,
    /\bI always\b\s+(.{3,200}?)(?:[.!?\n]|$)/i,
    /\bI never\b\s+(.{3,200}?)(?:[.!?\n]|$)/i,
    /\bAlways\b\s+(.{3,200}?)(?:[.!?\n]|$)/,
    /\bNever\b\s+(.{3,200}?)(?:[.!?\n]|$)/,
  ];
  const out: Candidate[] = [];
  for (const pat of patterns) {
    const m = userMessage.match(pat);
    if (!m) continue;
    const body = m[1]?.trim();
    if (!body) continue;
    out.push({
      tier: "operator_profile",
      persona_id: personaId,
      created_at: nowIso(),
      updated_at: nowIso(),
      content: clip(`Operator preference: ${m[0].trim()}`),
      source,
      importance: 0.8,
      tags: ["operator", "preference"],
      pruned: false,
    });
    // One preference per turn — multiple matches usually overlap.
    break;
  }
  return out;
}

// ----- heuristic 5: explicit memory request -----

function extractExplicitRequests(
  userMessage: string,
  personaId: MemoryPersonaScope
): Candidate[] {
  const m = userMessage.match(
    /\b(?:remember that|don'?t forget(?:\s+that)?|note that|please remember)\b\s+(.{3,400}?)(?:[.!?\n]|$)/i
  );
  if (!m) return [];
  const body = m[1].trim();
  if (!body) return [];
  return [
    {
      tier: "short_term",
      persona_id: personaId,
      // Explicit requests come from the operator, even though they're
      // extracted heuristically — operator INTENT was explicit. Marked
      // operator_explicit so the audit chain reflects the intent.
      created_at: nowIso(),
      updated_at: nowIso(),
      content: clip(body),
      source: "operator_explicit",
      importance: 0.9,
      tags: ["explicit"],
      pruned: false,
    },
  ];
}

// ----- public surface -----

/**
 * Extract memory candidates from a completed conversation turn.
 *
 * Pure function (modulo new Date()): same inputs → same outputs. Safe
 * to call from anywhere; the caller decides whether to persist via
 * writeMemory(). The `existingProfile` parameter is present per the
 * directive's signature even though the v1 heuristics don't dedupe
 * against it yet — Phase 9B can use it to suppress duplicate
 * preference extractions ("I prefer brevity" stored 12 times).
 */
export async function extractMemories(
  userMessage: string,
  assistantResponse: string,
  personaId: MemoryPersonaScope,
  // Reserved for Phase 9B dedup ("don't re-extract a preference we
  // already know"). Prefixed with _ so strict-unused TS rules pass.
  _existingProfile: OperatorProfile | null
): Promise<Candidate[]> {
  if (!userMessage || userMessage.trim().length === 0) return [];

  const source: MemorySource = "conversation";
  const candidates: Candidate[] = [
    ...extractExplicitRequests(userMessage, personaId),
    ...extractOperatorIdentity(userMessage, personaId, source),
    ...extractPreferences(userMessage, personaId, source),
    ...extractProjectReferences(userMessage, assistantResponse, personaId, source),
    ...extractNamedEntities(userMessage, personaId, source),
  ];
  return candidates;
}
