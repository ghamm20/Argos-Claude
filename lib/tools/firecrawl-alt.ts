// lib/tools/firecrawl-alt.ts — T34 firecrawl_alt (web, safe, keyless)
//
// A Firecrawl-style structured scraper built on the existing regex HTML utils
// (no new dependency — these same helpers power web_crawl). Two-stage: fetch
// HTML, extract title/content/links/images/metadata; if the page looks like a
// JS-rendered SPA (almost no static text + an app-root div), flag it so the
// caller can fall back to web_crawl / a headful path. 6h cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetch } from "../web";
import { stripHtml, extractTitle, extractMetadata, extractLinks, extractImages } from "./util";

export const ID = "firecrawl_alt";
const TTL = 6 * 60 * 60 * 1000;

function looksLikeSpa(html: string, text: string): boolean {
  const hasAppRoot = /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(html);
  const heavyScript = (html.match(/<script[\s>]/gi) ?? []).length >= 5;
  return text.length < 400 && hasAppRoot && heavyScript;
}

export const execute: ToolExecute = async (params) => {
  const url = String(params.url ?? "").trim();
  if (!url) return toolErr(ID, "url is required");
  if (!/^https?:\/\//i.test(url)) return toolErr(ID, "url must start with http(s)://");

  const r = await webFetch({
    source: "firecrawl_alt",
    op: "scrape",
    url,
    query: url,
    ttlMs: TTL,
    timeoutMs: 30_000,
    retries: 2,
    maxChars: 400_000,
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
  });
  if (!r.ok) return toolErr(ID, r.error ?? "fetch failed");

  const html = r.body;
  const text = stripHtml(html);
  const isSpa = looksLikeSpa(html, text);
  return toolOk(ID, `Scraped ${url} (${text.length} chars${isSpa ? ", SPA — content may be incomplete" : ""})`, {
    data: {
      url,
      title: extractTitle(html),
      content: text.slice(0, 16000),
      links: extractLinks(html, url, 100),
      images: extractImages(html, url, 50),
      metadata: extractMetadata(html),
      isSpa,
      spaHint: isSpa ? "Static HTML is sparse — this is a JS-rendered page. Try web_crawl for a best-effort render." : null,
      fromCache: r.fromCache,
    },
    sources: [url],
  });
};
