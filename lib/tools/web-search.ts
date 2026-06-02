// lib/tools/web-search.ts — T1 Web Search (safe)
//
// DuckDuckGo Lite HTML endpoint (no API key). Returns the top 5 results.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { fetchText, decodeEntities } from "./util";

export const ID = "web_search";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Decode a DDG Lite redirect href (//duckduckgo.com/l/?uddg=ENC) to the
 *  real target URL. */
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

export function parseDdgLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Result title links carry class="result-link".
  const linkRe =
    /<a[^>]*class=["']result-link["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const altLinkRe =
    /<a[^>]*href=["']([^"']+)["'][^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;

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
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? "",
    });
  }
  return results;
}

/** Reusable search primitive for T3/T4. */
export async function ddgSearch(query: string, limit = 5): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const r = await fetchText(url, {
    timeoutMs: 10_000,
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!r.ok || !r.text) return [];
  return parseDdgLite(r.text).slice(0, limit);
}

export const execute: ToolExecute = async (params) => {
  const query = String(params.query ?? "").trim();
  if (!query) return toolErr(ID, "query is required");
  let results: SearchResult[];
  try {
    results = await ddgSearch(query, 5);
  } catch (e) {
    return toolErr(ID, `search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return toolOk(ID, `${results.length} result(s) for "${query}"`, {
    data: { query, results },
    sources: results.map((r) => r.url),
  });
};
