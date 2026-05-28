// lib/research/crawler.ts
//
// HTML crawl + extraction. Fetches top-N URLs by credibilityScore,
// strips noise (nav/footer/sidebar/ads), pulls main content, and
// extracts "fact-like" sentences for the fact-checker.
//
// Zero new dependencies — string-based HTML parsing. We don't need
// a full DOM; we just need text. The heuristics are deliberately
// conservative — we'd rather skip noise than include it.

import type { CrawledPage, SearchResult } from "./types";
import { CRAWL_TIMEOUT_MS, USER_AGENT } from "./types";

const DEFAULT_MAX_PAGES = 3;
const MAX_EXTRACTED_CHARS = 2000;

// ----- HTML → text -----

/** Strip an element entirely when its open tag contains any of the
 *  given class/id needles. Heuristic but effective on news-site
 *  templates. */
const STRIP_NEEDLES = [
  "nav",
  "navigation",
  "navbar",
  "header",
  "footer",
  "sidebar",
  "aside",
  "menu",
  "ad ",
  "ad-",
  "advert",
  "advertis",
  "cookie",
  "popup",
  "modal",
  "banner",
  "comments",
  "newsletter",
  "subscribe",
  "promo",
  "share",
  "social",
];

/** Remove <script>, <style>, <noscript>, <svg>, and elements whose
 *  open-tag string contains a STRIP_NEEDLES substring (case-
 *  insensitive). Then strip remaining tags and collapse whitespace.
 *  Returns plain text. */
function htmlToText(html: string): string {
  let s = html;
  // Drop heavyweight non-text blocks first.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");

  // Strip elements whose open tag matches a noise needle. We match
  // pairs of the same tag name to keep nesting correct enough for
  // news templates. This is intentionally one-pass; nested noise
  // inside noise still gets caught when we re-collapse later.
  const elemRe =
    /<(div|nav|aside|section|header|footer|ul|li|span)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  // Keep replacing until stable (up to 3 passes, since our regex
  // can't see nested matches in one go).
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    s = s.replace(elemRe, (match, _tag, attrs) => {
      const a = (attrs as string).toLowerCase();
      if (STRIP_NEEDLES.some((n) => a.includes(n))) {
        changed = true;
        return " ";
      }
      return match;
    });
    if (!changed) break;
  }

  // Strip remaining tags + decode entities.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
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

/** Cleanly truncate to maxChars at a sentence boundary. If no
 *  sentence terminator within range, hard-cut. */
function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  // Walk back from the cut to find the last sentence-ending punct.
  const m = slice.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].length >= maxChars * 0.5) return m[0];
  return slice.trim() + "…";
}

/** Extract the page <title> for the crawled page; falls back to a
 *  trimmed slug of the URL. */
function extractTitle(html: string, url: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    const t = decodeEntities(m[1].replace(/\s+/g, " ").trim());
    if (t.length > 0) return t.slice(0, 200);
  }
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

// ----- fact extraction -----

/**
 * Extract sentences that look like "facts" — contain at least one
 * number, proper noun, or quoted segment. Heuristic; intentionally
 * permissive so the fact-checker has plenty to cross-reference.
 *
 * Caps at 12 facts per page to keep cache + downstream prompts
 * compact.
 */
export function extractFacts(text: string): string[] {
  if (!text) return [];
  // Split into sentences via terminator + space + capital. Forgiving
  // of news prose; will occasionally include sub-clauses, which is
  // fine for cross-reference.
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18 && s.length <= 360);

  const out: string[] = [];
  for (const s of sentences) {
    const hasNumber = /\b\d/.test(s);
    const hasProper = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(s);
    const hasQuote = /["“'].{4,}["”']/.test(s);
    if (hasNumber || hasProper || hasQuote) {
      out.push(s);
      if (out.length >= 12) break;
    }
  }
  return out;
}

// ----- crawl -----

async function crawlOne(url: string): Promise<CrawledPage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (res.status === 403 || res.status === 429) {
      // Polite skip — respect rate limit / robots.txt-by-status.
      // eslint-disable-next-line no-console
      console.warn(`[research/crawl] ${res.status} ${url}`);
      return null;
    }
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[research/crawl] HTTP ${res.status} ${url}`);
      return null;
    }
    const ctype = res.headers.get("content-type") ?? "";
    // Skip binaries/PDFs — out of scope for the crawler.
    if (
      !/text\/html|application\/xhtml/i.test(ctype) &&
      !ctype.startsWith("text/")
    ) {
      // eslint-disable-next-line no-console
      console.warn(`[research/crawl] skip non-html ${ctype} ${url}`);
      return null;
    }
    const html = await res.text();
    const title = extractTitle(html, url);
    const text = htmlToText(html);
    const extractedText = truncateAtSentence(text, MAX_EXTRACTED_CHARS);
    const facts = extractFacts(extractedText);
    return {
      url,
      title,
      extractedText,
      facts,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/crawl] fetch failed ${url}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Crawl the top results by credibility. Concurrent fetch (Promise.all)
 * caps total wall time at ~CRAWL_TIMEOUT_MS rather than N× it.
 * Returns only the pages that succeeded.
 */
export async function crawlResults(
  results: SearchResult[],
  maxPages: number = DEFAULT_MAX_PAGES
): Promise<CrawledPage[]> {
  if (!results || results.length === 0) return [];
  const sorted = [...results].sort(
    (a, b) => b.credibilityScore - a.credibilityScore
  );
  const top = sorted.slice(0, maxPages);
  const settled = await Promise.allSettled(top.map((r) => crawlOne(r.url)));
  const pages: CrawledPage[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value !== null) pages.push(s.value);
  }
  return pages;
}
