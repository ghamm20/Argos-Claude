// lib/research/providers/duckduckgo.ts
//
// Primary web search provider. Scrapes DuckDuckGo's HTML-only
// surface (html.duckduckgo.com/html/) — no API key, no rate limit
// in normal operator-scale use. DDG occasionally serves a "verify
// you're human" page when it suspects bot traffic; we treat that
// as a soft failure and let the chain fall through to the next
// provider.
//
// HTML parsing: zero new dependencies. We use regex + simple string
// slicing against the well-known DDG result-block structure:
//
//   <div class="result results_links results_links_deep web-result">
//     ...
//     <a class="result__a" href="...">{title}</a>
//     <a class="result__snippet" href="...">{snippet}</a>
//     <a class="result__url">{display url}</a>
//   </div>
//
// DDG also URL-encodes outbound links via /l/?uddg=<encoded>. We
// decode those so the crawler gets the real target URL.

import type { SearchProvider } from "./base";
import type { SearchQuery, SearchResult } from "../types";
import { SEARCH_TIMEOUT_MS, USER_AGENT } from "../types";

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

function decodeDdgRedirect(href: string): string {
  // Pattern: /l/?uddg=https%3A%2F%2Fexample.com%2F&rut=...
  // Also the post-2022 pattern: //duckduckgo.com/l/?uddg=...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function parseDdgHtml(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  // Match each result block. DDG's HTML often varies slightly; this
  // regex is forgiving of attribute order + extra whitespace.
  const blockRe =
    /<div[^>]*class="[^"]*result(?:\s+results_links[^"]*)?"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && out.length < max) {
    const block = m[1];
    const titleM = block.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!titleM) continue;
    const hrefRaw = titleM[1];
    const url = decodeDdgRedirect(decodeEntities(hrefRaw));
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(stripTags(titleM[2]));
    const snippetM = block.match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/
    );
    const snippet = snippetM
      ? decodeEntities(stripTags(snippetM[1])).slice(0, 280)
      : "";
    out.push({
      title: title || url,
      url,
      snippet,
      source: "duckduckgo",
      credibilityScore: 0.6,
    });
  }
  return out;
}

export const duckduckgoProvider: SearchProvider = {
  id: "duckduckgo",
  isAvailable() {
    // Always considered available — failure is detected at runtime
    // by empty results. No env / config gate.
    return true;
  },
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const url = `${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query.query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 4xx/5xx → soft failure
        // eslint-disable-next-line no-console
        console.warn(`[research/ddg] HTTP ${res.status} for ${query.query}`);
        return [];
      }
      const html = await res.text();
      // Soft-failure detection: the "anomaly" page is small and
      // lacks any result blocks. Returning [] lets the chain
      // fall through.
      if (html.length < 500 || /class="anomaly/i.test(html)) {
        // eslint-disable-next-line no-console
        console.warn(`[research/ddg] anomaly response`);
        return [];
      }
      return parseDdgHtml(html, query.maxResults);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[research/ddg] fetch failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  },
};
