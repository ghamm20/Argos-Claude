// lib/tools/web-crawl.ts — T2 Web Crawl / Page Reader
// (safe, UNRESTRICTED 2026-06-02)
//
// Full structured page extraction: up to 50,000 chars of text, links, images,
// metadata. 60s timeout, follows redirects, retries across multiple user-agents
// (the honest "render as best we can" path — no JS engine without new deps).
// Optional recursive crawl follows links up to 2 levels deep (bounded by a
// total-page cap) when the operator requests it.

import { toolOk, toolErr, type ToolExecute } from "./types";
import {
  fetchWithUserAgents,
  stripHtml,
  extractTitle,
  extractMetaDescription,
  extractMetadata,
  extractLinks,
  extractImages,
} from "./util";

export const ID = "web_crawl";

const MAX_CONTENT = 50_000;
const CRAWL_TIMEOUT_MS = 60_000;
const MAX_RECURSIVE_PAGES = 20;
const MAX_DEPTH = 2;

export interface CrawlResult {
  url: string;
  title: string | null;
  description: string | null;
  /** Back-compat alias of fullText (older callers read `content`). */
  content: string;
  fullText: string;
  links: string[];
  images: string[];
  metadata: Record<string, string>;
  crawlDepth: number;
  timestamp: string;
  truncated: boolean;
}

/** Reusable, unrestricted crawl primitive for T3/T4. */
export async function crawlPage(url: string, depth = 0): Promise<CrawlResult | null> {
  const r = await fetchWithUserAgents(url, { timeoutMs: CRAWL_TIMEOUT_MS, maxChars: 2_000_000 });
  if (!r.ok || !r.text) return null;
  const full = stripHtml(r.text);
  const fullText = full.slice(0, MAX_CONTENT);
  return {
    url,
    title: extractTitle(r.text),
    description: extractMetaDescription(r.text),
    content: fullText,
    fullText,
    links: extractLinks(r.text, url),
    images: extractImages(r.text, url),
    metadata: extractMetadata(r.text),
    crawlDepth: depth,
    timestamp: new Date().toISOString(),
    truncated: full.length > MAX_CONTENT,
  };
}

export const execute: ToolExecute = async (params) => {
  const url = String(params.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return toolErr(ID, "a valid http(s) url is required");
  }
  const depth = Math.max(0, Math.min(MAX_DEPTH, Number(params.depth ?? 0) || 0));
  const recursive = params.recursive === true || depth > 0;

  try {
    if (!recursive) {
      const res = await crawlPage(url, 0);
      if (!res) return toolErr(ID, `could not fetch ${url}`);
      return toolOk(ID, `read ${res.fullText.length} chars from ${res.title ?? url}`, {
        data: res,
        sources: [url],
      });
    }

    // Recursive BFS, bounded by depth AND a total-page cap (no domain filter —
    // any link may be followed, but the total is capped so it stays sane).
    const visited = new Set<string>();
    const pages: CrawlResult[] = [];
    let frontier = [url];
    for (let d = 0; d <= depth && pages.length < MAX_RECURSIVE_PAGES; d++) {
      const next: string[] = [];
      for (const u of frontier) {
        if (visited.has(u) || pages.length >= MAX_RECURSIVE_PAGES) continue;
        visited.add(u);
        const res = await crawlPage(u, d);
        if (!res) continue;
        pages.push(res);
        if (d < depth) {
          for (const l of res.links) {
            if (!visited.has(l)) next.push(l);
          }
        }
      }
      frontier = next.slice(0, MAX_RECURSIVE_PAGES * 2);
    }
    if (pages.length === 0) return toolErr(ID, `could not fetch ${url}`);
    return toolOk(
      ID,
      `crawled ${pages.length} page(s) to depth ${depth} from ${pages[0].title ?? url}`,
      { data: { root: url, depth, pageCount: pages.length, pages }, sources: pages.map((p) => p.url) }
    );
  } catch (e) {
    return toolErr(ID, `crawl failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
