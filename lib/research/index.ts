// lib/research/index.ts
//
// Phase 10 research orchestrator. Coordinates planner → searcher →
// crawler → factchecker → reporter with cache integration and an
// optional one-shot feedback loop (max 2 iterations) when the first
// pass confidence falls below the threshold.
//
// Public surface:
//   runResearch(userMessage, personaId) → ResearchReport | null
//
// Failure mode: returns null on any of:
//   - needsResearch === false (no network fires)
//   - pipeline budget exceeded with no usable partial state
// Otherwise returns a report — possibly with quality="PARTIAL" or
// "FAILED" — but NEVER throws.

import type {
  ResearchIntent,
  ResearchReport,
  SearchQuery,
  SearchResult,
} from "./types";
import {
  CONFIDENCE_REFINE_THRESHOLD,
  MAX_ITERATIONS,
  PIPELINE_BUDGET_MS,
} from "./types";
import {
  needsResearch,
  classifyIntent,
  planQueries,
  detectLocation,
} from "./planner";
import { executeSearch } from "./searcher";
import { crawlResults } from "./crawler";
import { checkFacts } from "./factchecker";
import { generateReport } from "./reporter";
import {
  buildCacheKey,
  getCachedReport,
  cacheReport,
} from "./cache";

/** True if the wall budget has been exhausted. */
function budgetExhausted(start: number): boolean {
  return Date.now() - start > PIPELINE_BUDGET_MS;
}

/** Build refinement queries when the first pass under-delivered.
 *  Strategy: take the lowest-confidence findings + rephrase. For
 *  weather/news this means broader location queries; for ai_updates
 *  it means swapping which sub-query failed; for crawl/general it
 *  means a single more-specific or more-generic restatement. */
function buildFollowUpQueries(
  originalMessage: string,
  intent: ResearchIntent,
  prev: ResearchReport
): SearchQuery[] {
  switch (intent) {
    case "weather": {
      // Re-fire the missing locations if the first pass missed one.
      const seen = new Set(
        prev.results
          .filter((r) => r.source === "wttr.in")
          .map((r) => r.title.toLowerCase())
      );
      const missing: SearchQuery[] = [];
      if (![...seen].some((t) => t.includes("atlanta"))) {
        missing.push({
          query: "weather Atlanta GA",
          intent,
          location: "atlanta",
          maxResults: 1,
        });
      }
      if (![...seen].some((t) => t.includes("orlando"))) {
        missing.push({
          query: "weather Orlando FL",
          intent,
          location: "orlando",
          maxResults: 1,
        });
      }
      return missing;
    }

    case "news":
      // Different angle: top headlines for whatever location we have.
      return [
        {
          query: "national top headlines",
          intent,
          location: null,
          maxResults: 5,
        },
      ];

    case "ai_updates":
      return [
        {
          query: "AI model release announcement today",
          intent,
          location: null,
          maxResults: 5,
        },
      ];

    case "crawl":
    case "general":
    default: {
      // Append "overview" / "summary" to shake more results loose.
      const base = originalMessage.replace(/[?!.]+$/, "").trim();
      return [
        {
          query: `${base} overview`,
          intent,
          location: detectLocation(originalMessage),
          maxResults: 5,
        },
      ];
    }
  }
}

/** Concurrent search across all planned queries. Order is preserved
 *  in the merged result list for citation stability. */
async function runQueries(queries: SearchQuery[]): Promise<SearchResult[]> {
  if (queries.length === 0) return [];
  const settled = await Promise.allSettled(
    queries.map((q) => executeSearch(q))
  );
  const all: SearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") all.push(...s.value);
  }
  return all;
}

/**
 * Top-level orchestrator.
 *
 *   personaId is accepted but currently unused — Phase 11 will use
 *   it to scope per-persona research preferences (e.g. Sage gets
 *   more iterations, Bobby gets less crawl). For Phase 10 every
 *   persona uses the same pipeline.
 */
export async function runResearch(
  userMessage: string,
  // Underscore prefix marks intentionally-unused; Phase 11 will use
  // it for per-persona policy.
  _personaId: string
): Promise<ResearchReport | null> {
  if (!needsResearch(userMessage)) return null;

  const start = Date.now();
  const intent = classifyIntent(userMessage);
  const location = detectLocation(userMessage);
  const cacheKey = buildCacheKey(intent, location);

  // ---- Cache hit ----
  const cached = await getCachedReport(cacheKey);
  if (cached) return cached;

  // ---- Iteration 1: plan + search + crawl + factcheck + report ----
  const queries = planQueries(userMessage, intent);
  const results = await runQueries(queries);

  if (budgetExhausted(start)) {
    const fc = { verifiedFacts: [], conflicts: [], unverified: [] };
    return generateReport(intent, queries, results, [], fc, 1);
  }

  const pages = await crawlResults(results);
  if (budgetExhausted(start)) {
    const fc = checkFacts(pages);
    const partial = generateReport(intent, queries, results, pages, fc, 1);
    // Don't cache a budget-exceeded partial; it'd lock in the bad
    // state for the full TTL.
    return partial;
  }
  const fc = checkFacts(pages);
  let report = generateReport(intent, queries, results, pages, fc, 1);

  // ---- Iteration 2 (feedback loop) ----
  // Fire only when:
  //   - confidence below threshold
  //   - quality isn't already SUFFICIENT/CONFLICTED (no point
  //     refining a verdict the operator should see)
  //   - we have budget left
  //   - iteration count < MAX_ITERATIONS
  if (
    report.confidenceScore < CONFIDENCE_REFINE_THRESHOLD &&
    (report.quality === "PARTIAL" || report.quality === "FAILED") &&
    !budgetExhausted(start) &&
    report.iteration < MAX_ITERATIONS
  ) {
    const followUps = buildFollowUpQueries(userMessage, intent, report);
    if (followUps.length > 0) {
      const moreResults = await runQueries(followUps);
      if (!budgetExhausted(start) && moreResults.length > 0) {
        const morePages = await crawlResults(moreResults);
        const combinedResults = [...report.results, ...moreResults];
        const combinedPages = [...report.crawledPages, ...morePages];
        const combinedFc = checkFacts(combinedPages);
        report = generateReport(
          intent,
          [...report.queries, ...followUps],
          combinedResults,
          combinedPages,
          combinedFc,
          2
        );
      }
    }
  }

  // ---- Cache + return ----
  // Don't cache FAILED reports — operator may want to retry when
  // network recovers, and a FAILED entry in cache would block
  // retries for the full TTL.
  if (report.quality !== "FAILED") {
    try {
      await cacheReport(cacheKey, report);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[research] cache write failed (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  return report;
}

// Re-export public surfaces for the chat route + tools page.
export { needsResearch, classifyIntent, planQueries } from "./planner";
export {
  getCacheStatus,
  clearCache,
  pruneCache,
  buildCacheKey,
} from "./cache";
export type {
  ResearchIntent,
  ResearchReport,
  ResearchQuality,
  SearchQuery,
  SearchResult,
  CrawledPage,
} from "./types";
