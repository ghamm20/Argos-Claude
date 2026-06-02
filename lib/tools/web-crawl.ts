// lib/tools/web-crawl.ts — T2 Web Crawl / Page Reader (safe)
//
// Fetch a URL, strip HTML, return title + meta description + the first 3000
// chars of readable text.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { fetchText, stripHtml, extractTitle, extractMetaDescription } from "./util";

export const ID = "web_crawl";

const MAX_CONTENT = 3000;

export interface CrawlResult {
  url: string;
  title: string | null;
  description: string | null;
  content: string;
  truncated: boolean;
}

/** Reusable crawl primitive for T3. */
export async function crawlPage(url: string): Promise<CrawlResult | null> {
  const r = await fetchText(url, { timeoutMs: 15_000, maxChars: 400_000 });
  if (!r.ok || !r.text) return null;
  const full = stripHtml(r.text);
  return {
    url,
    title: extractTitle(r.text),
    description: extractMetaDescription(r.text),
    content: full.slice(0, MAX_CONTENT),
    truncated: full.length > MAX_CONTENT,
  };
}

export const execute: ToolExecute = async (params) => {
  const url = String(params.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return toolErr(ID, "a valid http(s) url is required");
  }
  let res: CrawlResult | null;
  try {
    res = await crawlPage(url);
  } catch (e) {
    return toolErr(ID, `crawl failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res) return toolErr(ID, `could not fetch ${url}`);
  return toolOk(ID, `read ${res.content.length} chars from ${res.title ?? url}`, {
    data: res,
    sources: [url],
  });
};
