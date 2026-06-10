// lib/chat/blocks.ts
//
// Phase 2 (2026-06-10) — chat-orchestrator extraction. System-prompt block
// builders + canon-suppression list moved VERBATIM from
// app/api/chat/route.ts. No logic changes.

import type { Confidence, RetrievalHit } from "@/lib/vault/types";
import type { ResearchReport } from "@/lib/research/types";

export const TRUTH_MODE_CLAUSE = [
  "",
  "TRUTH MODE ACTIVE:",
  "- Explicitly surface uncertainty when present.",
  "- Hedge claims that aren't directly supported by retrieval context (prefer \"the source suggests\" or \"based on the available material\" over \"it is\").",
  "- When you cite [N], the citation must point to a chunk you actually used.",
  "- If you don't know, say \"I don't know\" instead of speculating.",
  "- Do not invent citations or sources.",
].join("\n");

export interface CitedHit {
  index: number;
  text: string;
  filename: string;
  chunkIndex: number;
  score: number;
  /** Phase 3: bucketed confidence — "high" | "medium" | "low" */
  confidence: Confidence;
  docId: string;
}

// Canon regression fix Option E (2026-05-28). When Bart is asked about
// a canon character by name, suppress vault retrieval entirely for
// that turn — the vault was actively misleading the model on these
// queries (top-N chunks rarely surface character-specific content,
// and the model confabulated identities by stitching unrelated
// retrieval tokens together). Bart's system prompt already carries
// the canon block; with retrieval off he leans on it directly.
//
// Operational queries (anything without a canon name) still use the
// vault normally. All other personas always use the vault per their
// own retrieval defaults.
export const BART_CANON_NAMES = [
  "faquarl",
  "jabor",
  "nouda",
  "queezle",
  "nathaniel",
  "mandrake",
  "kitty",
  "ptolemy",
  "lovelace",
  "harlequin",
  "simpkin",
  "honorius",
];

export function isCanonQuery(personaId: string, message: string): boolean {
  if (personaId !== "bartimaeus") return false;
  const lower = message.toLowerCase();
  // Word-boundary match keeps "kitty" from triggering on "kitty-corner"
  // or similar. Anchors on \b which handles punctuation + spaces.
  return BART_CANON_NAMES.some((name) => {
    const re = new RegExp(`\\b${name}\\b`, "i");
    return re.test(lower);
  });
}

// Phase 10 — research context block. Sits between memory and vault
// in the system prompt. Format mirrors buildRetrievalBlock so the
// model parses it consistently.
export function buildResearchBlock(r: ResearchReport): string {
  const lines: string[] = [];
  const ageNote = r.cachedAt
    ? ` (cached; generated ${r.cachedAt})`
    : "";
  lines.push(
    `[RESEARCH CONTEXT — ${r.intent} — Quality: ${r.quality} — Confidence: ${r.confidenceScore.toFixed(2)}${ageNote}]`
  );
  lines.push(`Summary: ${r.summary}`);
  if (r.findings.length > 0) {
    lines.push("Key findings:");
    for (const f of r.findings) lines.push(`- ${f}`);
  }
  if (r.conflicts.length > 0) {
    lines.push("Conflicts flagged:");
    for (const c of r.conflicts) lines.push(`- ${c}`);
  }
  if (r.citations.length > 0) {
    lines.push("Sources:");
    for (const c of r.citations) lines.push(c);
  }
  lines.push("[/RESEARCH CONTEXT]");
  return lines.join("\n");
}

export function buildRetrievalBlock(hits: RetrievalHit[]): string {
  const lines = hits.map((h, i) => {
    const idx = i + 1;
    const cleaned = h.text.replace(/\s+/g, " ").trim();
    return `[${idx}] ${cleaned} (source: ${h.filename}, chunk ${h.chunkIndex})`;
  });
  // Canon regression fix (2026-05-28). Original wrapper said "If no
  // chunk is relevant, say so plainly and do not invent citations."
  // The model read that as "vault is authoritative for what exists"
  // and started refusing to discuss canon characters (Faquarl, Jabor,
  // etc.) whenever the top-N retrieved chunks didn't contain their
  // names. Broke Bart's canon identity directive in the deployed
  // config (where retrieval defaults on for Bart).
  //
  // New wrapper: vault is advisory, not authoritative. Personas keep
  // their own knowledge + memory; vault supplements. The no-fabricated-
  // citations contract stays intact.
  return [
    "RELEVANT CONTEXT (supplementary vault excerpts — cite as [1], [2] only when you actually use them):",
    ...lines,
    "",
    "This material supplements your own knowledge and memory. When the vault doesn't cover what the user asked, answer from your own knowledge — do NOT claim a topic or character doesn't exist just because it's absent from these excerpts. Cite [N] only when you use vault material; never invent citations.",
  ].join("\n");
}
