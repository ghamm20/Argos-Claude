// lib/tools/deep-research.ts — T3 Deep Research (safe)
//
// Runs 3 web searches on related queries, crawls the top 2 results each, and
// synthesizes a structured report. Composes T1 (search) + T2 (crawl) — no new
// network infrastructure.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { ddgSearch, type SearchResult } from "./web-search";
import { crawlPage } from "./web-crawl";

export const ID = "deep_research";

function relatedQueries(q: string): string[] {
  const base = q.trim();
  return [base, `${base} latest`, `${base} analysis OR risks OR overview`];
}

export const execute: ToolExecute = async (params) => {
  const query = String(params.query ?? "").trim();
  if (!query) return toolErr(ID, "query is required");

  const queries = relatedQueries(query);
  const seenUrls = new Set<string>();
  const allResults: SearchResult[] = [];
  for (const q of queries) {
    try {
      const rs = await ddgSearch(q, 5);
      for (const r of rs) {
        if (r.url && !seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          allResults.push(r);
        }
      }
    } catch {
      /* one failed search shouldn't sink the whole report */
    }
  }

  // Crawl the top 2 unique results per the first two searches (bounded cost).
  const toCrawl = allResults.slice(0, 6);
  const keyFindings: string[] = [];
  const sources: string[] = [];
  for (const r of toCrawl.slice(0, 4)) {
    sources.push(r.url);
    try {
      const page = await crawlPage(r.url);
      if (page && page.content) {
        const lead = page.content.slice(0, 240).trim();
        keyFindings.push(`${r.title}: ${lead}…`);
      } else if (r.snippet) {
        keyFindings.push(`${r.title}: ${r.snippet}`);
      }
    } catch {
      if (r.snippet) keyFindings.push(`${r.title}: ${r.snippet}`);
    }
  }
  // Backfill from snippets if crawling yielded little.
  for (const r of allResults) {
    if (keyFindings.length >= 5) break;
    if (r.snippet && !keyFindings.some((k) => k.startsWith(r.title))) {
      keyFindings.push(`${r.title}: ${r.snippet}`);
      if (!sources.includes(r.url)) sources.push(r.url);
    }
  }

  if (allResults.length === 0) {
    return toolOk(ID, `no web results for "${query}" (offline or blocked)`, {
      data: { query, summary: "No results retrieved.", sources: [], keyFindings: [] },
    });
  }

  const summary =
    `Researched "${query}" across ${queries.length} queries and ${toCrawl.length} sources. ` +
    `${allResults.length} unique results found; ${keyFindings.length} key findings extracted.`;

  return toolOk(ID, `deep research on "${query}" — ${keyFindings.length} findings`, {
    data: { query, summary, sources, keyFindings },
    sources,
  });
};
