// lib/tools/web-search.ts — T1 Web Search (safe, UNRESTRICTED 2026-06-02)
//
// Uses DuckDuckGo's full HTML endpoint (more + richer results than Lite),
// retries across multiple user-agents, 30s timeout, and returns ALL results
// it can parse (no 5-result cap). Lite is kept as a fallback parser.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { fetchText, decodeEntities, CRAWL_USER_AGENTS } from "./util";

export const ID = "web_search";

const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 30;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Decode a DDG redirect href (//duckduckgo.com/l/?uddg=ENC) → real target. */
function unwrapDdg(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/** Parser for the full html.duckduckgo.com/html/ results page. */
export function parseDdgHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe =
    /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({
      url: unwrapDdg(m[1]),
      title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    });
  }
  const snippets: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snippetRe.exec(html)) !== null) {
    snippets.push(decodeEntities(s[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
  }
  for (let i = 0; i < links.length; i++) {
    if (!links[i].url || !links[i].title) continue;
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
  }
  return results;
}

/** Parser for the lite.duckduckgo.com fallback. */
export function parseDdgLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe =
    /<a[^>]*class=["']result-link["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const altLinkRe =
    /<a[^>]*href=["']([^"']+)["'][^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;
  const links: Array<{ url: string; title: string }> = [];
  for (const re of [linkRe, altLinkRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      links.push({
        url: unwrapDdg(m[1]),
        title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
      });
    }
    if (links.length) break;
  }
  const snippets: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snippetRe.exec(html)) !== null) {
    snippets.push(decodeEntities(s[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
  }
  for (let i = 0; i < links.length; i++) {
    if (!links[i].url || !links[i].title) continue;
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
  }
  return results;
}

/** Reusable, unrestricted search primitive for T3/T4. Tries the full HTML
 *  endpoint across multiple UAs, then the lite endpoint, returning up to
 *  `limit` results (default 30). */
export async function ddgSearch(query: string, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
  const endpoints: Array<{ url: string; parse: (h: string) => SearchResult[] }> = [
    { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parse: parseDdgHtml },
    { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, parse: parseDdgLite },
  ];
  for (const ep of endpoints) {
    for (const ua of CRAWL_USER_AGENTS) {
      const r = await fetchText(ep.url, {
        timeoutMs: SEARCH_TIMEOUT_MS,
        headers: { "user-agent": ua, "accept-language": "en-US,en;q=0.9" },
      });
      if (r.ok && r.text) {
        const parsed = ep.parse(r.text);
        if (parsed.length > 0) return parsed.slice(0, limit);
      }
    }
  }
  return [];
}

export const execute: ToolExecute = async (params) => {
  const query = String(params.query ?? "").trim();
  if (!query) return toolErr(ID, "query is required");
  const limit =
    typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 50) : DEFAULT_LIMIT;
  let results: SearchResult[];
  try {
    results = await ddgSearch(query, limit);
  } catch (e) {
    return toolErr(ID, `search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return toolOk(ID, `${results.length} result(s) for "${query}"`, {
    data: { query, results },
    sources: results.map((r) => r.url),
  });
};
