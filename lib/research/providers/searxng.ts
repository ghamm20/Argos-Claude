// lib/research/providers/searxng.ts
//
// SearXNG provider — operator-supplied self-hosted instance. Honors
// the USB-native sovereign philosophy: when the operator stands up
// their own SearXNG (Docker, fly.io, locally) they configure
// SEARXNG_BASE_URL and we route web queries through it instead of
// DDG. Aggregates 70+ engines so retrieval is generally better
// than any single backend.
//
// Disabled by default — isAvailable() returns false unless the env
// var is set. The chain skips us cleanly when off.

import type { SearchProvider } from "./base";
import type { SearchQuery, SearchResult } from "../types";
import { SEARCH_TIMEOUT_MS, USER_AGENT } from "../types";

function baseUrl(): string | null {
  const u = process.env.SEARXNG_BASE_URL;
  if (!u || u.trim().length === 0) return null;
  return u.replace(/\/+$/, "");
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  publishedDate?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export const searxngProvider: SearchProvider = {
  id: "searxng",
  isAvailable() {
    return baseUrl() !== null;
  },
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const root = baseUrl();
    if (!root) return [];
    // SearXNG JSON API: /search?q=...&format=json
    const url = `${root}/search?q=${encodeURIComponent(query.query)}&format=json`;
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
        console.warn(`[research/searxng] HTTP ${res.status}`);
        return [];
      }
      const j = (await res.json()) as SearxngResponse;
      const results = (j?.results ?? [])
        .filter((r) => !!r.url && /^https?:\/\//i.test(r.url))
        .slice(0, query.maxResults)
        .map<SearchResult>((r) => ({
          title: (r.title ?? r.url!).trim(),
          url: r.url!,
          snippet: (r.content ?? "").slice(0, 280),
          source: `searxng:${r.engine ?? "?"}`,
          publishedAt: r.publishedDate,
          credibilityScore: 0.7, // multi-engine aggregate; nudges above DDG
        }));
      return results;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[research/searxng] fetch failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  },
};
