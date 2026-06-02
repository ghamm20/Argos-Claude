// lib/tools/deep-research.ts — T3 Deep Research
// (safe, UNRESTRICTED 2026-06-02)
//
// Runs up to 10 related searches and crawls the top 5 results of each (deduped,
// capped at 30 total crawls, run with concurrency so wall-clock stays sane),
// then synthesizes a structured report. Composes the now-unrestricted T1/T2.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { ddgSearch, type SearchResult } from "./web-search";
import { fetchText, stripHtml, extractTitle, CRAWL_USER_AGENTS } from "./util";

export const ID = "deep_research";

const SEARCHES = 10;
const PER_SEARCH_CRAWL = 5;
const MAX_TOTAL_CRAWLS = 30;
const CRAWL_TIMEOUT_MS = 20_000;
const CONCURRENCY = 5;

function relatedQueries(q: string): string[] {
  const base = q.trim();
  return [
    base,
    `${base} latest`,
    `${base} overview`,
    `${base} analysis`,
    `${base} risks`,
    `${base} explained`,
    `${base} news`,
    `${base} comparison`,
    `${base} guide`,
    `${base} details`,
  ].slice(0, SEARCHES);
}

interface CrawledPage {
  url: string;
  title: string;
  excerpt: string;
  length: number;
}

async function lightCrawl(url: string, title: string): Promise<CrawledPage | null> {
  const r = await fetchText(url, {
    timeoutMs: CRAWL_TIMEOUT_MS,
    maxChars: 800_000,
    headers: { "user-agent": CRAWL_USER_AGENTS[0], "accept-language": "en-US,en;q=0.9" },
  });
  if (!r.ok || !r.text) return null;
  const text = stripHtml(r.text);
  return {
    url,
    title: extractTitle(r.text) || title,
    excerpt: text.slice(0, 1200),
    length: text.length,
  };
}

/** Bounded-concurrency map. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const execute: ToolExecute = async (params) => {
  const query = String(params.query ?? "").trim();
  if (!query) return toolErr(ID, "query is required");

  const queries = relatedQueries(query);
  const seen = new Set<string>();
  const allResults: SearchResult[] = [];
  const toCrawl: SearchResult[] = [];

  for (const q of queries) {
    let rs: SearchResult[] = [];
    try {
      rs = await ddgSearch(q, 10);
    } catch {
      /* one failed search shouldn't sink the report */
    }
    let added = 0;
    for (const r of rs) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      allResults.push(r);
      if (added < PER_SEARCH_CRAWL && toCrawl.length < MAX_TOTAL_CRAWLS) {
        toCrawl.push(r);
        added++;
      }
    }
  }

  if (allResults.length === 0) {
    return toolOk(ID, `no web results for "${query}" (offline or blocked)`, {
      data: { query, summary: "No results retrieved.", sources: [], keyFindings: [] },
    });
  }

  const crawled = (await pool(toCrawl, CONCURRENCY, (r) => lightCrawl(r.url, r.title))).filter(
    (p): p is CrawledPage => p !== null
  );

  const keyFindings: string[] = [];
  const sources: string[] = [];
  for (const p of crawled) {
    keyFindings.push(`${p.title}: ${p.excerpt.slice(0, 280).trim()}…`);
    sources.push(p.url);
  }
  // Backfill from snippets for results we didn't crawl.
  for (const r of allResults) {
    if (keyFindings.length >= 30) break;
    if (r.snippet && !sources.includes(r.url)) {
      keyFindings.push(`${r.title}: ${r.snippet}`);
      sources.push(r.url);
    }
  }

  const summary =
    `Researched "${query}" across ${queries.length} queries. ` +
    `${allResults.length} unique results; ${crawled.length} pages crawled in full; ` +
    `${keyFindings.length} findings.`;

  return toolOk(ID, `deep research on "${query}" — ${crawled.length} crawled, ${keyFindings.length} findings`, {
    data: {
      query,
      summary,
      sources,
      keyFindings,
      uniqueResults: allResults.length,
      crawledPages: crawled.map((p) => ({ url: p.url, title: p.title, excerpt: p.excerpt, length: p.length })),
    },
    sources,
  });
};
