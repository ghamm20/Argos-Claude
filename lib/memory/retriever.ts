// lib/memory/retriever.ts
//
// Phase 9 — memory retrieval + system-prompt formatter.
//
// Called by the chat route just before assembling the system prompt.
// Pulls the most relevant memories for this persona + this user
// message and returns a compact context block ready to splice into
// the system message between the persona prompt and the vault
// retrieval block.
//
// Token budget: rough character → token estimate (4 chars/token,
// English bias). Stays under the supplied budget by dropping entity
// context first, then project context. Operator profile and
// short_term are non-negotiable when present.

import {
  readMemories,
  searchMemoriesByTag,
  getOperatorProfile,
} from "./store";
import type {
  MemoryEntry,
  MemoryPersonaScope,
  OperatorProfile,
} from "./schema";

// ----- token budget helpers -----

const DEFAULT_MAX_TOKEN_ESTIMATE = 800;
const CHARS_PER_TOKEN_ESTIMATE = 4;

function tokensOf(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN_ESTIMATE);
}

// ----- formatting -----

/** Operator profile → 2 short lines (name+role, preferences as
 *  key=value pairs joined by ` · `). Empty string if profile is
 *  blank. */
function formatOperatorProfile(p: OperatorProfile): string {
  const lines: string[] = [];
  const ident = [p.name, p.role].filter((x) => x && x.trim()).join(" — ");
  if (ident) lines.push(`Operator: ${ident}`);
  if (p.context && p.context.trim()) {
    lines.push(`Context: ${p.context.trim()}`);
  }
  const prefs = Object.entries(p.preferences || {})
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}=${v}`);
  if (prefs.length > 0) lines.push(`Preferences: ${prefs.join(" · ")}`);
  return lines.join("\n");
}

/** Compact one-line summary of a memory entry for the context block. */
function formatEntry(e: MemoryEntry): string {
  const tagSummary =
    e.tags.length > 0 ? ` [${e.tags.slice(0, 3).join(", ")}]` : "";
  return `- ${e.content}${tagSummary}`;
}

/** Find any project-name tokens in the user message so we can pull
 *  matching project memories. Returns a list of tag substrings to
 *  feed searchMemoriesByTag(). */
function projectTagsForMessage(userMessage: string): string[] {
  const lc = userMessage.toLowerCase();
  // Keep this list in sync with KNOWN_PROJECTS in extractor.ts. Two
  // sources of truth here is a small cost; extracting both heuristic
  // sets into a shared module is a Phase 9B refactor.
  const knownTagPairs: { alias: string; tag: string }[] = [
    { alias: "argos", tag: "project:argos" },
    { alias: "jenna", tag: "project:jenna" },
    { alias: "parascope", tag: "project:parascope" },
    { alias: "sentry", tag: "project:sentry" },
    { alias: "cortex", tag: "project:cortex" },
    { alias: "halal jordan", tag: "project:halal-jordan" },
    { alias: "halaljordan", tag: "project:halal-jordan" },
  ];
  const out = new Set<string>();
  for (const { alias, tag } of knownTagPairs) {
    if (lc.includes(alias)) out.add(tag);
  }
  return Array.from(out);
}

/** Tokenize the user message into rough words; used as the search
 *  signal for entity memories. Lowercased, stripped of punctuation,
 *  unique. */
function messageTokens(userMessage: string): string[] {
  return Array.from(
    new Set(
      userMessage
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3)
    )
  );
}

// ----- main retrieval -----

/**
 * Build the memory context block that goes into the system prompt.
 *
 * Always-on layers (when present, in priority order):
 *   1. Operator profile (compact form)
 *   2. Top 3 short_term entries by importance
 *   3. Top 3 project entries matching project names in the user msg
 *   4. Top 2 entity entries whose tags match words in the user msg
 *
 * Budget-aware: starts with everything, then sheds layer 4, then
 * layer 3, until total token estimate fits under maxTokenEstimate.
 * Layers 1 + 2 are non-negotiable — if they alone blow the budget,
 * we ship them anyway (the alternative is a useless empty block).
 *
 * Returns "" when nothing relevant exists or every layer failed —
 * the chat route then skips the memory injection cleanly.
 */
export async function retrieveMemoriesForPrompt(
  personaId: MemoryPersonaScope,
  userMessage: string,
  maxTokenEstimate: number = DEFAULT_MAX_TOKEN_ESTIMATE
): Promise<string> {
  // Each layer is rendered independently; we assemble the final block
  // by joining the non-empty layers. Errors per-layer are swallowed
  // with a warning — memory must never break chat.

  let profileBlock = "";
  try {
    const profile = await getOperatorProfile();
    if (profile) {
      const formatted = formatOperatorProfile(profile);
      if (formatted) profileBlock = formatted;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[memory] operator profile read failed: ${(err as Error).message}`
    );
  }

  let shortTermBlock = "";
  try {
    const top = await readMemories(personaId, "short_term", 3);
    if (top.length > 0) {
      shortTermBlock = ["Recent context:", ...top.map(formatEntry)].join("\n");
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[memory] short_term read failed: ${(err as Error).message}`
    );
  }

  let projectBlock = "";
  try {
    const projTags = projectTagsForMessage(userMessage);
    if (projTags.length > 0) {
      const hits: MemoryEntry[] = [];
      const seen = new Set<string>();
      for (const tag of projTags) {
        const tier = await searchMemoriesByTag(personaId, tag);
        for (const e of tier) {
          if (e.tier !== "project") continue;
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          hits.push(e);
        }
      }
      hits.sort((a, b) => b.importance - a.importance);
      const top = hits.slice(0, 3);
      if (top.length > 0) {
        projectBlock = ["Project context:", ...top.map(formatEntry)].join("\n");
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[memory] project search failed: ${(err as Error).message}`
    );
  }

  let entityBlock = "";
  try {
    const tokens = messageTokens(userMessage);
    if (tokens.length > 0) {
      const hits: MemoryEntry[] = [];
      const seen = new Set<string>();
      for (const tok of tokens) {
        // Only search for tokens that look proper-noun-ish (length ≥4)
        // to keep this cheap. Cap iterations to avoid pathological
        // 100-token messages.
        if (tok.length < 4) continue;
        const tier = await searchMemoriesByTag(personaId, tok);
        for (const e of tier) {
          if (e.tier !== "entity") continue;
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          hits.push(e);
        }
        if (hits.length >= 6) break; // before sort+trim
      }
      hits.sort((a, b) => b.importance - a.importance);
      const top = hits.slice(0, 2);
      if (top.length > 0) {
        entityBlock = ["Entity context:", ...top.map(formatEntry)].join("\n");
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[memory] entity search failed: ${(err as Error).message}`
    );
  }

  // Compose, applying budget in shedding order: entity, then project.
  const ordered: { name: string; body: string; sheddable: boolean }[] = [
    { name: "profile", body: profileBlock, sheddable: false },
    { name: "short_term", body: shortTermBlock, sheddable: false },
    { name: "project", body: projectBlock, sheddable: true },
    { name: "entity", body: entityBlock, sheddable: true },
  ];

  // Strip empty layers up front.
  let layers = ordered.filter((l) => l.body.trim().length > 0);
  if (layers.length === 0) return "";

  // Header + footer overhead. The wrapper costs ~10 tokens. Account
  // for it so the budget actually includes the wrapper.
  const WRAPPER = ["[MEMORY CONTEXT]", "[/MEMORY CONTEXT]"];
  const wrapperTokens = WRAPPER.reduce((acc, s) => acc + tokensOf(s), 0);

  const totalTokens = () =>
    layers.reduce((acc, l) => acc + tokensOf(l.body), 0) + wrapperTokens;

  // Drop sheddable layers from the END (least priority) until under
  // budget. If we exhaust sheddables and still overflow, ship anyway
  // — non-sheddable layers are intentionally above-budget allowed.
  while (totalTokens() > maxTokenEstimate) {
    const lastSheddableIdx = (() => {
      for (let i = layers.length - 1; i >= 0; i--) {
        if (layers[i].sheddable) return i;
      }
      return -1;
    })();
    if (lastSheddableIdx === -1) break;
    layers.splice(lastSheddableIdx, 1);
  }

  if (layers.length === 0) return "";

  return [
    WRAPPER[0],
    ...layers.map((l) => l.body),
    WRAPPER[1],
  ].join("\n");
}
