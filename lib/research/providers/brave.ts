// lib/research/providers/brave.ts
//
// Brave Search API provider. Optional fallback — disabled unless the
// operator supplies a BRAVE_SEARCH_API_KEY (Brave has a generous
// free tier for personal use). When configured, slots into the chain
// AFTER DDG/SearXNG so we keep zero-key providers first.

import type { SearchProvider } from "./base";
import type { SearchQuery, SearchResult } from "../types";
import { SEARCH_TIMEOUT_MS, USER_AGENT } from "../types";

function apiKey(): string | null {
  const k = process.env.BRAVE_SEARCH_API_KEY;
  if (!k || k.trim().length === 0) return null;
  return k.trim();
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string; // e.g. "3 hours ago"
  page_age?: string; // ISO sometimes
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export const braveProvider: SearchProvider = {
  id: "brave",
  isAvailable() {
    return apiKey() !== null;
  },
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const key = apiKey();
    if (!key) return [];
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query.query)}&count=${query.maxResults}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          "x-subscription-token": key,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[research/brave] HTTP ${res.status}`);
        return [];
      }
      const j = (await res.json()) as BraveResponse;
      const results = (j?.web?.results ?? [])
        .filter((r) => !!r.url && /^https?:\/\//i.test(r.url))
        .slice(0, query.maxResults)
        .map<SearchResult>((r) => ({
          title: (r.title ?? r.url!).trim(),
          url: r.url!,
          snippet: (r.description ?? "").slice(0, 280),
          source: "brave",
          publishedAt: r.page_age,
          credibilityScore: 0.75, // paid API → slightly above DDG/SearXNG
        }));
      return results;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[research/brave] fetch failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  },
};
