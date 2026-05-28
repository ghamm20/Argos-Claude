// lib/research/memory.ts
//
// Phase 11 — write research results to the Phase 9 memory store.
// Called from the afterReport hook on every SUFFICIENT report.
//
// Storage shape: short_term tier, persona-scoped, tagged
// ["research","auto","intent:<intent>"]. Operator can prune via the
// Memory page like any other entry.
//
// Token budget: 200 tokens ≈ 800 chars (chars/4 estimate, matching
// the Phase 9 retriever). Anything over gets truncated at sentence
// boundary.
//
// Pruning: this module doesn't prune; Phase 9's normal read-time
// tombstone filter handles it. Entries older than 7 days are
// pruned by the periodic scheduler-tick prune (see below).

import { writeMemory, readMemories, pruneMemory } from "../memory/store";
import type {
  MemoryPersonaScope,
  MemoryEntry,
} from "../memory/schema";
import type { ResearchReport } from "./types";

const TOKEN_BUDGET = 200;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = TOKEN_BUDGET * CHARS_PER_TOKEN;

const RESEARCH_MEMORY_MAX_AGE_DAYS = 7;

/** Truncate cleanly at sentence boundary if possible, else hard-cut. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const m = slice.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].length >= maxChars * 0.5) return m[0];
  return slice.trim() + "…";
}

/** Format a research report as a single memory-line block. */
function condense(report: ResearchReport): string {
  const lines: string[] = [];
  lines.push(`[${report.intent}] ${report.summary}`);
  if (report.findings.length > 0) {
    lines.push(`Findings: ${report.findings.slice(0, 2).join(" · ")}`);
  }
  // Top two citation URLs only — operator can dig deeper via the
  // Tools page cache view if they want full sources.
  const cites = report.citations.slice(0, 2).map((c) => {
    const m = c.match(/(https?:\/\/\S+)$/);
    return m ? m[1] : c;
  });
  if (cites.length > 0) {
    lines.push(`Citations: ${cites.join(" · ")}`);
  }
  lines.push(`Confidence: ${report.confidenceScore.toFixed(2)}`);
  return truncate(lines.join(" "), MAX_CHARS);
}

/**
 * Write a SUFFICIENT report to memory for the given persona. Callers
 * pass the persona id from chat context (chat route) or "bartimaeus"
 * for scheduled runs (configurable in a future iteration).
 *
 * Non-fatal: returns false on any write error. The afterReport hook
 * doesn't surface this back to the user.
 */
export async function writeResearchMemory(
  report: ResearchReport,
  personaId: MemoryPersonaScope
): Promise<{ ok: boolean; reason: string }> {
  if (report.quality !== "SUFFICIENT") {
    return { ok: false, reason: `skipped: quality=${report.quality}` };
  }
  try {
    const content = condense(report);
    const now = new Date().toISOString();
    await writeMemory({
      tier: "short_term",
      persona_id: personaId,
      created_at: now,
      updated_at: now,
      content,
      source: "system",
      // Research memories rank below explicit-operator (0.9) but above
      // conversational extraction (0.4): 0.55. Higher for SUFFICIENT
      // with high confidence.
      importance: Math.min(0.85, 0.55 + report.confidenceScore * 0.3),
      tags: [
        "research",
        "auto",
        `intent:${report.intent}`,
      ],
      pruned: false,
    });
    return { ok: true, reason: "written" };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/memory] write failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return {
      ok: false,
      reason: `write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Prune research memory entries older than 7 days. Walks the
 * persona's short_term tier and tombstones any auto-research entry
 * past the age limit. Cheap; safe to call frequently from the
 * scheduler tick.
 *
 * Returns the count tombstoned.
 */
export async function pruneOldResearchMemories(
  personaId: MemoryPersonaScope
): Promise<number> {
  const cutoffMs = Date.now() - RESEARCH_MEMORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  try {
    const entries: MemoryEntry[] = await readMemories(
      personaId,
      "short_term"
    );
    for (const e of entries) {
      if (!e.tags.includes("research") || !e.tags.includes("auto")) continue;
      const t = Date.parse(e.created_at);
      if (!Number.isFinite(t)) continue;
      if (t < cutoffMs) {
        await pruneMemory(e.id);
        pruned++;
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/memory] prune failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
  return pruned;
}
