// lib/research/types.ts
//
// Phase 10 — research pipeline schema. Types + constants only;
// zero logic. Imported by planner / providers / searcher / crawler /
// factchecker / reporter / cache / index and the API + UI surfaces.
//
// All `Promise<X | null>` returns from public entry points are
// intentional: research must NEVER throw into the chat path. A
// failed pipeline returns null (or a partial-quality report) and
// chat continues without it.

export type ResearchIntent =
  | "weather"
  | "news"
  | "ai_updates"
  | "general"
  | "crawl"
  // Phase 11 — arXiv academic paper stream. Hits export.arxiv.org's
  // Atom feed; cached 6h. Distinct from ai_updates because the source
  // (peer-reviewed papers) and cadence (slower-moving) differ.
  | "arxiv";

/** Operator's two home markets + a few common variants. Used by the
 *  planner's location detector. */
export type ResearchLocation =
  | "atlanta"
  | "orlando"
  | "winter_springs"
  | null;

/** Final report quality verdict — appended by the reporter after the
 *  full pipeline (incl. any feedback iterations) completes. Drives
 *  the HUD indicator + Bart's narration voice. */
export type ResearchQuality =
  | "SUFFICIENT" // answered the question; high confidence
  | "PARTIAL"    // some data; gaps exist; flagged
  | "FAILED"     // sources unreachable / nothing returned
  | "CONFLICTED"; // contradictions found across sources

export interface SearchQuery {
  query: string;
  intent: ResearchIntent;
  /** Operator-relevant locations. null = "both home markets" or
   *  "not location-scoped" depending on intent. */
  location?: ResearchLocation;
  /** Max results per provider call. 5 is the default per the
   *  directive; planner may lower for cheap intents. */
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Provider source ID: "wttr.in" | "ajc" | "orlando-sentinel" |
   *  "duckduckgo" | "reddit:r/Atlanta" | "searxng" | "brave" etc. */
  source: string;
  publishedAt?: string;
  /** 0.0-1.0 — used by the crawler to pick top-N to fetch and by
   *  the reporter when averaging into confidence. Provider sets
   *  baseline (e.g. RSS=0.8, DDG=0.6, Reddit=0.5); reporter may
   *  adjust after fact-check. */
  credibilityScore: number;
}

export interface CrawledPage {
  url: string;
  title: string;
  /** Cleaned main content. Nav/footer/sidebar stripped. Truncated
   *  to 2000 chars at a sentence boundary. */
  extractedText: string;
  /** Sentences containing numbers, proper nouns, or quoted
   *  statements — heuristic "interesting claim" extraction. */
  facts: string[];
  fetchedAt: string;
}

export interface ResearchReport {
  id: string;
  intent: ResearchIntent;
  queries: SearchQuery[];
  results: SearchResult[];
  crawledPages: CrawledPage[];
  /** 2-3 sentence executive summary. */
  summary: string;
  /** Top 5-7 bullet points, most important first. */
  findings: string[];
  /** Numbered citation list: "[1] {title} — {url}" form. */
  citations: string[];
  /** 0.0-1.0 — average of source credibility, weighted by
   *  fact-verification ratio. */
  confidenceScore: number;
  /** Flagged contradictions across sources. */
  conflicts: string[];
  generatedAt: string;
  /** TTL in minutes: weather=30, news=60, ai_updates=120,
   *  general=180. */
  ttlMinutes: number;
  /** Iteration count — 1 on the first pass, 2 on the feedback pass.
   *  Always ≤ 2 (hard cap). */
  iteration: number;
  /** Final-pass verdict; set by reporter after fact-check. */
  quality: ResearchQuality;
  /** Set when this report came from cache. ISO timestamp. */
  cachedAt?: string;
}

/** Cache entry — wraps the report with an absolute expiry stamp so
 *  prune doesn't need to know about per-intent TTLs. */
export interface CacheEntry {
  report: ResearchReport;
  expiresAt: string;
}

/** On-disk cache shape. Single JSON file at data/research/cache.json. */
export interface ResearchCache {
  [cacheKey: string]: CacheEntry;
}

/** Per-intent TTL in minutes. Single source of truth — cache + reporter
 *  both reference this. */
export const TTL_MINUTES: Record<ResearchIntent, number> = {
  weather: 30,
  news: 60,
  ai_updates: 120,
  general: 180,
  crawl: 180,
  arxiv: 360, // 6h per Phase 11 directive — papers move slow
};

/** Feedback-loop config. Below this confidence the orchestrator runs
 *  one follow-up iteration with refined queries. Max 2 iterations
 *  total. */
export const CONFIDENCE_REFINE_THRESHOLD = 0.6;
export const MAX_ITERATIONS = 2;

/** Hard total-pipeline budget. Beyond this we return whatever partial
 *  state exists with quality:"PARTIAL". */
export const PIPELINE_BUDGET_MS = 30_000;

/** Crawl budget per page. */
export const CRAWL_TIMEOUT_MS = 10_000;

/** Search fetch budget per provider call. */
export const SEARCH_TIMEOUT_MS = 8_000;

/** Common User-Agent for all outbound HTTP. */
export const USER_AGENT = "ARGOS-Research/1.0";
