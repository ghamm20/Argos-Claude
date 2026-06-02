// lib/tools/searxng.ts — T28 searxng_search (web, safe)
//
// Primary general search via the self-hosted SearXNG (127.0.0.1:8080) — it
// aggregates Google/Bing/DDG/etc and returns structured JSON. If the local
// instance is down or has JSON disabled, falls back to the DuckDuckGo HTML
// scrape (web_search). 15min cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";
import { ddgSearch } from "./web-search";

export const ID = "searxng_search";
const TTL = 15 * 60 * 1000;
const BASE = "http://127.0.0.1:8080"; // local SearXNG (Rule-4 allows 127.0.0.1)
const CATEGORIES = new Set(["general", "news", "images", "videos", "science", "it"]);

interface SxResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  category?: string;
  publishedDate?: string | null;
}
interface SxResp {
  results?: SxResult[];
  number_of_results?: number;
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const category = typeof params.category === "string" && CATEGORIES.has(params.category) ? params.category : "general";
  const url = `${BASE}/search?q=${encodeURIComponent(q)}&format=json&categories=${category}&safesearch=0`;

  const r = await webFetchJson<SxResp>({ source: "searxng", op: category, url, query: q, ttlMs: TTL, timeoutMs: 12_000, retries: 1 });
  if (r.ok && (r.data?.results?.length ?? 0) > 0) {
    const results = (r.data?.results ?? []).slice(0, 20).map((x) => ({
      title: (x.title ?? "").trim(),
      url: x.url ?? "",
      snippet: (x.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      engine: x.engine ?? null,
      category: x.category ?? category,
      published: x.publishedDate ?? null,
    })).filter((x) => x.url);
    return toolOk(ID, `SearXNG: ${results.length} result(s) for "${q}"`, {
      data: { query: q, category, engine: "searxng", results, fromCache: r.fromCache },
      sources: results.map((x) => x.url).slice(0, 10),
    });
  }

  // Fallback: DuckDuckGo HTML scrape (web_search primitive).
  try {
    const ddg = await ddgSearch(q, 15);
    if (ddg.length > 0) {
      return toolOk(ID, `SearXNG down — DDG fallback: ${ddg.length} result(s) for "${q}"`, {
        data: { query: q, category, engine: "duckduckgo-fallback", results: ddg, fromCache: false },
        sources: ddg.map((x) => x.url).slice(0, 10),
      });
    }
  } catch {
    /* fall through to error */
  }
  return toolErr(ID, r.error ? `SearXNG failed (${r.error}) and DDG fallback empty` : "no results from SearXNG or DDG fallback");
};
