// lib/memory-retrieve.ts
//
// Memory Phase (2026-06-02) — semantic cross-session memory: RETRIEVAL.
//
// Before each chat response, find facts relevant to the current message and
// format them as a compact recall block to PREPEND to the system prompt
// (additive — never replaces the persona prompt). Matching is a simple
// keyword + category overlap over operator_facts.jsonl; the last 500 chars of
// MEMORY.md supplement it. Capped at 300 chars, top 5 facts.
//
// Doctrine: graceful — any failure returns "no recall" and chat proceeds
// normally. The block deliberately tells the model to use the context
// naturally and NOT announce that it is recalling anything.
//
// Server-only (node fs).

import { promises as fsp } from "node:fs";
import { readFacts, memoryMdPath, type OperatorFact } from "./memory-extract";

const TOP_K = 5;
const MAX_INJECT_CHARS = 300;
const MD_TAIL_CHARS = 500;

// Common words that carry no retrieval signal — excluded from matching.
const STOP = new Set([
  "the", "and", "for", "that", "with", "you", "your", "are", "was", "this",
  "have", "has", "had", "what", "who", "whom", "tell", "about", "does", "did",
  "can", "could", "how", "why", "when", "where", "which", "there", "their",
  "they", "them", "from", "into", "out", "but", "not", "all", "any", "our",
  "his", "her", "she", "him", "its", "been", "were", "will", "would", "should",
  "just", "like", "want", "need", "know", "think", "say", "said", "get", "got",
  "make", "made", "give", "more", "some", "than", "then", "now", "also",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter(
    (t) => !STOP.has(t)
  );
}

/** Bullet lines (`- ...`) from the last 500 chars of MEMORY.md — the operator
 *  profile + recent-context facts. Graceful: [] on any error. */
async function memoryMdBullets(): Promise<string[]> {
  try {
    const raw = await fsp.readFile(memoryMdPath(), "utf8");
    const tail = raw.length > MD_TAIL_CHARS ? raw.slice(raw.length - MD_TAIL_CHARS) : raw;
    return (tail.match(/^- .+$/gm) ?? [])
      .map((l) => l.replace(/^-\s+/, "").replace(/\s*\([0-9.]+\)\s*$/, "").trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export interface MemoryRecall {
  /** number of relevant facts injected this turn */
  factsFound: number;
  /** whether a recall block was produced */
  injected: boolean;
  /** the system-prompt block (empty when nothing relevant) */
  block: string;
  /** the matched jsonl facts (for diagnostics/HUD) */
  facts: OperatorFact[];
}

const EMPTY: MemoryRecall = { factsFound: 0, injected: false, block: "", facts: [] };

/**
 * Retrieve relevant memories for the current user message. Keyword + category
 * match over operator_facts.jsonl (primary) plus MEMORY.md recent bullets
 * (supplementary). Returns up to TOP_K, formatted + capped at 300 chars.
 * Only produces a block when at least one relevant fact is found.
 */
export async function retrieveMemories(userMessage: string): Promise<MemoryRecall> {
  try {
    const msg = (userMessage ?? "").trim();
    if (!msg) return EMPTY;
    const qtokens = new Set(tokenize(msg));
    if (qtokens.size === 0) return EMPTY;

    const facts = await readFacts();
    if (facts.length === 0) return EMPTY;

    const scored = facts
      .map((f) => {
        const ftoks = tokenize(`${f.fact} ${f.category}`);
        let overlap = 0;
        for (const t of ftoks) if (qtokens.has(t)) overlap++;
        // category named directly in the query is a strong signal
        const catBonus = qtokens.has(f.category) ? 1 : 0;
        return { f, score: overlap + catBonus };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.f.confidence - a.f.confidence);

    const top = scored.slice(0, TOP_K).map((s) => s.f);
    if (top.length === 0) return EMPTY;

    // Build the recall block, capped at 300 chars.
    const header =
      "## What I recall (use naturally; do not announce that you are recalling):";
    let block = header;
    for (const f of top) {
      const line = `\n- ${f.fact}`;
      if (block.length + line.length > MAX_INJECT_CHARS) break;
      block += line;
    }

    // Supplement with one matching MEMORY.md bullet if there's room — this is
    // where the "last 500 chars of MEMORY.md" feeds in (operator profile).
    const bullets = await memoryMdBullets();
    const usedFacts = new Set(top.map((f) => f.fact.toLowerCase()));
    for (const b of bullets) {
      if (usedFacts.has(b.toLowerCase())) continue;
      const btoks = tokenize(b);
      if (!btoks.some((t) => qtokens.has(t))) continue;
      const line = `\n- ${b}`;
      if (block.length + line.length > MAX_INJECT_CHARS) break;
      block += line;
      break; // one supplemental line is enough
    }

    if (block.length > MAX_INJECT_CHARS) block = block.slice(0, MAX_INJECT_CHARS);

    return { factsFound: top.length, injected: true, block, facts: top };
  } catch {
    return EMPTY;
  }
}
