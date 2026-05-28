// lib/research/reporter.ts
//
// Assemble the final ResearchReport. Deterministic; no LLM call.
// The model gets to wrap this in its own voice when the report is
// injected into the chat system prompt — but the structured data
// (summary / findings / citations / quality) is computed here so
// it's verifiable and cacheable.

import type {
  CrawledPage,
  ResearchIntent,
  ResearchQuality,
  ResearchReport,
  SearchQuery,
  SearchResult,
} from "./types";
import { TTL_MINUTES } from "./types";
import type { FactCheckResult } from "./factchecker";

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(intent: ResearchIntent): string {
  // Compact id: <intent>-<base36 epoch ms>-<rand>. No collision risk
  // at operator scale; useful as a stable handle for the HUD + audit.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${intent}-${t}-${r}`;
}

/** Cap a list to N entries with stable ordering. */
function take<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

/** Build the citation lines. Format: "[N] {title} — {source} — {url}". */
function buildCitations(results: SearchResult[]): string[] {
  const out: string[] = [];
  // Dedupe by URL — different queries can surface the same source.
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    const idx = out.length + 1;
    out.push(`[${idx}] ${r.title.slice(0, 140)} — ${r.source} — ${r.url}`);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Compose the executive summary. Two cases:
 *
 *   1. Weather — we have a synthesized result whose snippet already
 *      contains parsed conditions. Splice them into a 2-sentence
 *      summary keyed off location.
 *   2. Other intents — count sources, mention top providers, give a
 *      one-line topic anchor. Honest about how thin the result set
 *      is when it's thin.
 */
function composeSummary(
  intent: ResearchIntent,
  queries: SearchQuery[],
  results: SearchResult[],
  pages: CrawledPage[]
): string {
  if (results.length === 0) {
    return "No sources returned for this query. Network may be unavailable, or the providers rejected the request.";
  }
  if (intent === "weather") {
    const lines = results
      .filter((r) => r.source === "wttr.in")
      .map((r) => `${r.title}: ${r.snippet}`);
    if (lines.length === 0) return results[0].snippet || "Weather data returned.";
    return lines.join(" — ");
  }
  const topQuery = queries[0]?.query ?? "(unspecified)";
  const providers = Array.from(new Set(results.map((r) => r.source))).slice(
    0,
    4
  );
  return `${results.length} source${results.length === 1 ? "" : "s"} returned for "${topQuery}" via ${providers.join(", ")}. ${pages.length} page${pages.length === 1 ? "" : "s"} crawled.`;
}

/**
 * Compose the findings list. Prefers verified facts from the
 * checker; fills the rest with the top result titles + snippets so
 * even a no-fact-crossover case still produces useful output.
 */
function composeFindings(
  results: SearchResult[],
  pages: CrawledPage[],
  fc: FactCheckResult
): string[] {
  const out: string[] = [];
  // Verified first; they passed the cross-reference bar.
  for (const v of take(fc.verifiedFacts, 3)) out.push(v);
  // Then top unverified facts (single-source but plausible).
  for (const u of take(fc.unverified, 2)) {
    if (out.length >= 5) break;
    if (out.includes(u)) continue;
    out.push(u);
  }
  // If we still need to fill: result titles + snippets.
  for (const r of results) {
    if (out.length >= 7) break;
    const line = r.snippet
      ? `${r.title}: ${r.snippet}`
      : r.title;
    if (out.some((o) => o.includes(r.title))) continue;
    out.push(line);
  }
  // Fall back to crawled-page titles when no results.
  if (out.length === 0 && pages.length > 0) {
    for (const p of pages.slice(0, 5)) out.push(p.title);
  }
  return out.slice(0, 7);
}

/**
 * Compute confidence score. Weighted average of result credibility,
 * boosted by verified-fact ratio, capped at 0.95.
 *
 * Empty result set → 0. Sole-source set → falls to source credibility
 * floor. Verified-fact ratio acts as a multiplier: 0 verified facts
 * → no boost, ratio ~1 → +0.1.
 */
function computeConfidence(
  results: SearchResult[],
  fc: FactCheckResult
): number {
  if (results.length === 0) return 0;
  const meanCred =
    results.reduce((acc, r) => acc + r.credibilityScore, 0) / results.length;
  const totalFacts =
    fc.verifiedFacts.length +
    fc.unverified.length +
    fc.conflicts.length;
  const verRatio =
    totalFacts > 0 ? fc.verifiedFacts.length / totalFacts : 0;
  const boost = verRatio * 0.1;
  // Source-count bonus: a single result is more suspect than three.
  // +0.03 per additional distinct source up to 4 (max +0.09).
  const distinctSources = new Set(results.map((r) => r.source)).size;
  const sourceBonus = Math.min(0.09, (distinctSources - 1) * 0.03);
  return Math.min(0.95, Math.max(0, meanCred + boost + sourceBonus));
}

/**
 * Decide the final quality verdict. Order of checks matters:
 *
 *   FAILED — no results AND no pages
 *   CONFLICTED — fact-checker flagged contradictions
 *   PARTIAL — confidence below 0.5 OR pages == 0 with results > 0
 *   SUFFICIENT — everything else
 */
function decideQuality(
  results: SearchResult[],
  pages: CrawledPage[],
  fc: FactCheckResult,
  confidence: number
): ResearchQuality {
  if (results.length === 0 && pages.length === 0) return "FAILED";
  if (fc.conflicts.length > 0) return "CONFLICTED";
  if (confidence < 0.5) return "PARTIAL";
  // For weather, even a single-source wttr response is sufficient
  // (the source IS the authority).
  return "SUFFICIENT";
}

/**
 * Build the report. Pure function over inputs — caller decides whether
 * to cache + when to invoke a follow-up iteration based on quality.
 */
export function generateReport(
  intent: ResearchIntent,
  queries: SearchQuery[],
  results: SearchResult[],
  crawledPages: CrawledPage[],
  factCheck: FactCheckResult,
  iteration: number = 1
): ResearchReport {
  const confidence = computeConfidence(results, factCheck);
  const quality = decideQuality(results, crawledPages, factCheck, confidence);
  return {
    id: makeId(intent),
    intent,
    queries,
    results,
    crawledPages,
    summary: composeSummary(intent, queries, results, crawledPages),
    findings: composeFindings(results, crawledPages, factCheck),
    citations: buildCitations(results),
    confidenceScore: confidence,
    conflicts: factCheck.conflicts,
    generatedAt: nowIso(),
    ttlMinutes: TTL_MINUTES[intent],
    iteration,
    quality,
  };
}
