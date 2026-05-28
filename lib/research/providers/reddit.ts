// lib/research/providers/reddit.ts
//
// Reddit JSON-API search provider. Reddit publishes JSON for every
// listing endpoint by appending `.json` — no auth required. Useful
// for:
//   - AI updates: r/MachineLearning, r/LocalLLaMA, r/artificial
//     (often surface model releases hours before Twitter/HN)
//   - Local news: r/Atlanta, r/orlando (community-curated context
//     mainstream RSS misses)
//
// Strategy: per intent, we pick a sub-list and hit
//   https://www.reddit.com/r/<sub>/search.json?q=<query>&sort=new&t=week&limit=N
// or the simpler new-posts listing when the query is too generic.
//
// Reddit rate-limits aggressive scrapers but is tolerant of polite
// User-Agent + sub-second cadence; the 8s timeout + chain fallback
// keeps us out of trouble.

import type { SearchProvider } from "./base";
import type { SearchQuery, SearchResult } from "../types";
import { SEARCH_TIMEOUT_MS, USER_AGENT } from "../types";

const SUB_MAP: Record<string, string[]> = {
  ai_updates: ["MachineLearning", "LocalLLaMA", "artificial"],
  news_atlanta: ["Atlanta"],
  news_orlando: ["orlando"],
};

interface RedditPost {
  title?: string;
  permalink?: string;
  selftext?: string;
  url?: string;
  subreddit?: string;
  created_utc?: number;
  num_comments?: number;
  score?: number;
}

interface RedditListingResponse {
  data?: {
    children?: Array<{ data?: RedditPost }>;
  };
}

function postToResult(p: RedditPost): SearchResult | null {
  const title = (p.title || "").trim();
  if (!title) return null;
  const permalink = p.permalink ? `https://www.reddit.com${p.permalink}` : null;
  const url = permalink ?? p.url ?? null;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const snippet = (p.selftext ?? "").replace(/\s+/g, " ").slice(0, 280);
  const publishedAt = p.created_utc
    ? new Date(p.created_utc * 1000).toISOString()
    : undefined;
  // Light credibility tilt: posts with engagement (>5 comments OR
  // >10 score) get a small bump. Cap at 0.65 — Reddit is
  // community-curated, not authoritative.
  let credibility = 0.5;
  if ((p.num_comments ?? 0) > 5 || (p.score ?? 0) > 10) credibility = 0.6;
  if ((p.num_comments ?? 0) > 50 || (p.score ?? 0) > 100) credibility = 0.65;
  return {
    title,
    url,
    snippet,
    source: `reddit:r/${p.subreddit ?? "?"}`,
    publishedAt,
    credibilityScore: credibility,
  };
}

async function fetchSub(
  sub: string,
  q: string,
  max: number
): Promise<SearchResult[]> {
  // When q is short or generic, /new.json gives the most recent posts;
  // otherwise /search.json with a query is better.
  const useSearch = q.trim().length >= 8;
  const url = useSearch
    ? `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(q)}&sort=new&t=week&restrict_sr=on&limit=${max}`
    : `https://www.reddit.com/r/${sub}/new.json?limit=${max}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[research/reddit] r/${sub} HTTP ${res.status}`);
      return [];
    }
    const j = (await res.json()) as RedditListingResponse;
    const posts = (j?.data?.children ?? [])
      .map((c) => c?.data)
      .filter((p): p is RedditPost => !!p);
    return posts
      .map(postToResult)
      .filter((r): r is SearchResult => r !== null)
      .slice(0, max);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/reddit] r/${sub} fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export const redditProvider: SearchProvider = {
  id: "reddit",
  isAvailable() {
    return true;
  },
  async search(query: SearchQuery): Promise<SearchResult[]> {
    // Pick subs based on intent + location.
    let subs: string[] | null = null;
    if (query.intent === "ai_updates") {
      subs = SUB_MAP.ai_updates;
    } else if (query.intent === "news") {
      if (query.location === "atlanta") subs = SUB_MAP.news_atlanta;
      else if (
        query.location === "orlando" ||
        query.location === "winter_springs"
      )
        subs = SUB_MAP.news_orlando;
    }
    if (!subs || subs.length === 0) return [];

    // Round-robin: 1 result from each sub (or floor of maxResults/sub
    // count, whichever larger), then dedupe by URL.
    const perSub = Math.max(1, Math.ceil(query.maxResults / subs.length));
    const all: SearchResult[] = [];
    for (const sub of subs) {
      const r = await fetchSub(sub, query.query, perSub);
      all.push(...r);
    }
    // Dedupe by URL.
    const seen = new Set<string>();
    const deduped: SearchResult[] = [];
    for (const r of all) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      deduped.push(r);
    }
    // Sort: published-desc, fall back to title order
    deduped.sort((a, b) => {
      if (a.publishedAt && b.publishedAt)
        return a.publishedAt < b.publishedAt ? 1 : -1;
      if (a.publishedAt) return -1;
      if (b.publishedAt) return 1;
      return 0;
    });
    return deduped.slice(0, query.maxResults);
  },
};
