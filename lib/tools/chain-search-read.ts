// lib/tools/chain-search-read.ts — T35 chain_search_to_read (web, safe)
//
// THE FIX for the shallow-snippet problem. One call that SEARCHES and READS:
//   1. search (SearXNG → DDG fallback; Wikipedia too for entity-ish queries)
//   2. score the top results for query relevance
//   3. read the best 3 with Jina Reader (full page content, not snippets)
//   4. return aggregated content + sources
//
// This is Bart's default for factual questions. 1h cache on the full chain.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetch, webFetchJson } from "../web";
import { cacheGet, cacheSet, cacheKey } from "../web/cache";
import { ddgSearch } from "./web-search";

export const ID = "chain_search_to_read";
const CHAIN_TTL = 60 * 60 * 1000;
const SEARXNG = "http://127.0.0.1:8080";

interface Hit { title: string; url: string; snippet: string; }

/** SearXNG JSON → fallback to DDG HTML scrape. */
async function search(query: string): Promise<{ engine: string; hits: Hit[] }> {
  const url = `${SEARXNG}/search?q=${encodeURIComponent(query)}&format=json&categories=general&safesearch=0`;
  const sx = await webFetchJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>({
    source: "searxng", op: "chain", url, query, ttlMs: 15 * 60 * 1000, timeoutMs: 10_000, retries: 1,
  });
  if (sx.ok && (sx.data?.results?.length ?? 0) > 0) {
    return {
      engine: "searxng",
      hits: (sx.data!.results!).filter((r) => r.url).map((r) => ({ title: (r.title ?? "").trim(), url: r.url!, snippet: (r.content ?? "").trim() })),
    };
  }
  const ddg = await ddgSearch(query, 10);
  return { engine: "duckduckgo", hits: ddg.map((d) => ({ title: d.title, url: d.url, snippet: d.snippet })) };
}

/** Keyword-overlap relevance score: query terms present in title+snippet. */
function score(query: string, hit: Hit): number {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (terms.length === 0) return 0;
  const hay = `${hit.title} ${hit.snippet}`.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  // small bonus for non-empty snippet + reputable-looking domains
  const bonus = (hit.snippet ? 0.1 : 0) + (/wikipedia|\.gov|\.edu/.test(hit.url) ? 0.15 : 0);
  return hits / terms.length + bonus;
}

async function jinaRead(url: string): Promise<string> {
  const r = await webFetch({
    source: "jina_reader", op: "chain-read", url: `https://r.jina.ai/${url}`, query: url,
    ttlMs: 12 * 60 * 60 * 1000, timeoutMs: 25_000, retries: 1, maxChars: 20_000,
    headers: { "x-return-format": "markdown", accept: "text/plain, */*" },
  });
  return r.ok ? r.body.trim() : "";
}

export const execute: ToolExecute = async (params) => {
  const query = String(params.query ?? "").trim();
  if (!query) return toolErr(ID, "query is required");
  const readCount = typeof params.read === "number" ? Math.min(Math.max(1, params.read), 5) : 3;

  // Whole-chain cache.
  const chainKey = cacheKey("chain://", { query, readCount });
  const cached = await cacheGet<Record<string, unknown>>(chainKey);
  if (cached) {
    return toolOk(ID, `chain (cached): "${query}"`, { data: { ...cached, fromCache: true }, sources: (cached.sources as string[]) ?? [] });
  }

  const { engine, hits } = await search(query);
  if (hits.length === 0) return toolErr(ID, "search returned no results to read");

  const ranked = [...hits].map((h) => ({ ...h, relevance: +score(query, h).toFixed(3) })).sort((a, b) => b.relevance - a.relevance);
  const toRead = ranked.slice(0, readCount);

  const read = await Promise.all(
    toRead.map(async (h) => {
      const content = await jinaRead(h.url);
      return { title: h.title, url: h.url, relevance: h.relevance, content: content.slice(0, 6000), readOk: content.length > 0 };
    })
  );
  const okReads = read.filter((r) => r.readOk);

  const aggregated = okReads
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
    .join("\n\n---\n\n")
    .slice(0, 18000);

  const sources = ranked.slice(0, 10).map((h) => h.url);
  const data = {
    query,
    engine,
    results: ranked.slice(0, 5).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet.slice(0, 200), relevance: h.relevance })),
    read: read.map((r) => ({ title: r.title, url: r.url, relevance: r.relevance, length: r.content.length, readOk: r.readOk })),
    aggregated,
    sources,
  };
  // Only cache a useful chain (something was actually read).
  if (okReads.length > 0) await cacheSet(chainKey, "chain://", data, CHAIN_TTL);

  return toolOk(ID, `chain: searched (${engine}, ${hits.length} hits) + read ${okReads.length}/${toRead.length} for "${query}"`, {
    data: { ...data, fromCache: false },
    sources,
  });
};
