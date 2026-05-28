// lib/research/searcher.ts
//
// Top-level search dispatcher. Routes each SearchQuery to the right
// backend(s):
//
//   weather  → wttr.in JSON (no API key)
//   news     → curated RSS feeds + Reddit supplementary for matched
//              location
//   ai_updates → web provider chain + Reddit r/MachineLearning etc.
//   crawl/general → web provider chain
//
// Every backend catches its own errors and returns []; never throws.
// SEARCH_TIMEOUT_MS clamps each individual fetch.

import type { SearchQuery, SearchResult } from "./types";
import { SEARCH_TIMEOUT_MS, USER_AGENT } from "./types";
import { runChain } from "./providers/chain";
import { redditProvider } from "./providers/reddit";

// ----- weather (wttr.in) -----

interface WttrCurrent {
  temp_F?: string;
  temp_C?: string;
  weatherDesc?: Array<{ value?: string }>;
  humidity?: string;
  windspeedMiles?: string;
  observation_time?: string;
}

interface WttrDayHourly {
  tempF?: string;
  weatherDesc?: Array<{ value?: string }>;
  time?: string;
}

interface WttrDay {
  date?: string;
  maxtempF?: string;
  mintempF?: string;
  hourly?: WttrDayHourly[];
}

interface WttrResponse {
  current_condition?: WttrCurrent[];
  weather?: WttrDay[];
  nearest_area?: Array<{ areaName?: Array<{ value?: string }> }>;
}

function wttrLocationToken(loc: SearchQuery["location"]): string {
  if (loc === "atlanta") return "Atlanta,GA";
  if (loc === "orlando") return "Orlando,FL";
  if (loc === "winter_springs") return "Winter+Springs,FL";
  // Caller already split queries per-location; null shouldn't happen
  // for weather. Fall back to Atlanta as the operator's primary.
  return "Atlanta,GA";
}

async function searchWeather(query: SearchQuery): Promise<SearchResult[]> {
  const tok = wttrLocationToken(query.location);
  const url = `https://wttr.in/${tok}?format=j1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[research/weather] HTTP ${res.status} for ${tok}`);
      return [];
    }
    const j = (await res.json()) as WttrResponse;
    const cur = j?.current_condition?.[0];
    if (!cur) return [];
    const desc = cur.weatherDesc?.[0]?.value ?? "unknown";
    const area =
      j?.nearest_area?.[0]?.areaName?.[0]?.value ??
      tok.replace("+", " ").replace(",", ", ");
    const days = j?.weather ?? [];
    const fcastLines: string[] = [];
    for (const d of days.slice(0, 3)) {
      if (!d?.date) continue;
      fcastLines.push(
        `${d.date}: ${d.mintempF ?? "?"}–${d.maxtempF ?? "?"}°F`
      );
    }
    // One synthesized SearchResult carries the parsed conditions in
    // the snippet so the crawler doesn't have to refetch wttr.
    const snippet = [
      `${desc}, ${cur.temp_F ?? "?"}°F`,
      `humidity ${cur.humidity ?? "?"}%`,
      `wind ${cur.windspeedMiles ?? "?"} mph`,
      `3-day: ${fcastLines.join(" · ")}`,
    ].join(" — ");
    return [
      {
        title: `Weather — ${area}`,
        url,
        snippet,
        source: "wttr.in",
        publishedAt: cur.observation_time ?? new Date().toISOString(),
        credibilityScore: 0.95,
      },
    ];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/weather] fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ----- news RSS feeds -----

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

function parseRssXml(xml: string, max: number): RssItem[] {
  const items: RssItem[] = [];
  // Match each <item>...</item> block; tolerant of attributes.
  const itemRe = /<item[\s>][\s\S]*?<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < max) {
    const block = m[0];
    const title = extractTagText(block, "title");
    const link = extractTagText(block, "link");
    const description = extractTagText(block, "description");
    const pubDate = extractTagText(block, "pubDate");
    if (!title || !link) continue;
    items.push({ title, link, description, pubDate });
  }
  return items;
}

function extractTagText(block: string, tag: string): string {
  // CDATA-tolerant: <tag><![CDATA[...]]></tag> OR <tag>...</tag>
  const re = new RegExp(
    `<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/${tag}>`,
    "i"
  );
  const m = block.match(re);
  if (!m) return "";
  const raw = (m[1] ?? m[2] ?? "").trim();
  return decodeXmlEntities(stripTags(raw));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

interface RssFeedSpec {
  url: string;
  source: string; // for SearchResult.source
  credibility: number;
}

function feedsForNewsQuery(q: SearchQuery): RssFeedSpec[] {
  // Local feeds first, then national for context.
  if (q.location === "atlanta") {
    return [
      {
        url: "https://www.ajc.com/arc/outboundfeeds/rss/",
        source: "ajc",
        credibility: 0.8,
      },
      // 11alive backup; AJC's RSS is sometimes empty during
      // maintenance windows.
      {
        url: "https://www.11alive.com/feeds/syndication/rss/news/local",
        source: "11alive",
        credibility: 0.75,
      },
    ];
  }
  if (q.location === "orlando" || q.location === "winter_springs") {
    return [
      {
        url: "https://www.orlandosentinel.com/arc/outboundfeeds/rss/",
        source: "orlando-sentinel",
        credibility: 0.8,
      },
      {
        url: "https://www.clickorlando.com/arc/outboundfeeds/rss/?outputType=xml",
        source: "clickorlando",
        credibility: 0.75,
      },
    ];
  }
  // ai_updates intent uses RSS too, but with AI-flavored feeds.
  if (q.intent === "ai_updates") {
    return [
      {
        url: "https://feeds.feedburner.com/venturebeat/SZYF",
        source: "venturebeat-ai",
        credibility: 0.75,
      },
      {
        url: "https://techcrunch.com/feed/",
        source: "techcrunch",
        credibility: 0.75,
      },
    ];
  }
  // Default national.
  return [
    {
      url: "https://feeds.npr.org/1001/rss.xml",
      source: "npr",
      credibility: 0.85,
    },
  ];
}

async function searchNewsFeed(spec: RssFeedSpec, max: number): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(spec.url, {
      headers: { "user-agent": USER_AGENT, accept: "application/rss+xml,*/*" },
      signal: controller.signal,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[research/rss] ${spec.source} HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = parseRssXml(xml, max);
    return items.map<SearchResult>((it) => ({
      title: it.title,
      url: it.link,
      snippet: it.description.slice(0, 280),
      source: spec.source,
      publishedAt: it.pubDate,
      credibilityScore: spec.credibility,
    }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/rss] ${spec.source} fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchNews(query: SearchQuery): Promise<SearchResult[]> {
  const feeds = feedsForNewsQuery(query);
  const all: SearchResult[] = [];
  for (const f of feeds) {
    const items = await searchNewsFeed(f, query.maxResults);
    all.push(...items);
  }
  // Sort newest-first when pubDate parses cleanly, else preserve
  // order.
  all.sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });
  return all.slice(0, query.maxResults);
}

// ----- arXiv (Phase 11) -----
//
// export.arxiv.org's Atom feed:
//   http://export.arxiv.org/api/query?search_query=all:<term>
//     &start=0&max_results=N&sortBy=submittedDate&sortOrder=descending
//
// Returns Atom XML — parsed with the same regex approach used for
// RSS. Tolerates malformed XML (returns [] on parse fail). Each
// <entry> contains: title, summary, author/name, published, id (URL),
// link (alternate). We map to one SearchResult per entry.

interface ArxivEntry {
  title: string;
  summary: string;
  authors: string[];
  published?: string;
  url: string;
}

function parseArxivXml(xml: string, max: number): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null && entries.length < max) {
    const block = m[1];
    const title = extractTagText(block, "title").replace(/\s+/g, " ").trim();
    const summary = extractTagText(block, "summary")
      .replace(/\s+/g, " ")
      .trim();
    const published = extractTagText(block, "published").trim();
    // Authors — multiple <author><name>X</name></author>; iterate.
    const authors: string[] = [];
    const authorRe = /<author\b[^>]*>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g;
    let am: RegExpExecArray | null;
    while ((am = authorRe.exec(block)) !== null) {
      const n = decodeXmlEntities(stripTags(am[1])).trim();
      if (n) authors.push(n);
    }
    // URL: prefer <link rel="alternate" href="..."/>, fall back to <id>
    let url = "";
    const linkRe =
      /<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"[^>]*\/?>/i;
    const lm = block.match(linkRe);
    if (lm) url = decodeXmlEntities(lm[1]);
    if (!url) {
      url = extractTagText(block, "id").trim();
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (!title) continue;
    entries.push({ title, summary, authors, published, url });
  }
  return entries;
}

async function searchArxiv(query: SearchQuery): Promise<SearchResult[]> {
  // arXiv's all:<term> query accepts free text; for multi-word topics
  // we URL-encode the whole string. sortBy=submittedDate gives the
  // operator newest-first results which is what they want for a
  // "what's new on arXiv" stream.
  // arXiv issues a 301 from http://export.arxiv.org → https://; use
  // https directly to skip the redirect round-trip.
  const url =
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query.query)}` +
    `&start=0&max_results=${query.maxResults}` +
    `&sortBy=submittedDate&sortOrder=descending`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/atom+xml,application/xml,*/*",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[research/arxiv] HTTP ${res.status} for ${query.query}`);
      return [];
    }
    const xml = await res.text();
    let entries: ArxivEntry[];
    try {
      entries = parseArxivXml(xml, query.maxResults);
    } catch (parseErr) {
      // Malformed XML — directive says handle gracefully.
      // eslint-disable-next-line no-console
      console.warn(
        `[research/arxiv] parse failed: ${
          (parseErr as Error).message
        } — returning []`
      );
      return [];
    }
    return entries.map<SearchResult>((e) => {
      const authorTrail =
        e.authors.length > 0
          ? ` — ${e.authors.slice(0, 4).join(", ")}${e.authors.length > 4 ? " et al." : ""}`
          : "";
      return {
        title: e.title,
        url: e.url,
        snippet: (e.summary || "").slice(0, 280) + authorTrail,
        source: "arxiv",
        publishedAt: e.published,
        // arXiv is peer-academic; high baseline credibility (above
        // mainstream tech press, below wttr.in's tautological 0.95).
        credibilityScore: 0.85,
      };
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/arxiv] fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ----- public dispatcher -----

/**
 * Execute a single SearchQuery. Returns 0..maxResults SearchResults.
 *
 * Web/general queries run through the provider chain (SearXNG →
 * Brave → DDG). News + ai_updates queries also pull Reddit as a
 * supplementary stream when applicable. arXiv hits export.arxiv.org
 * directly.
 *
 * Never throws.
 */
export async function executeSearch(
  query: SearchQuery
): Promise<SearchResult[]> {
  switch (query.intent) {
    case "weather":
      return searchWeather(query);

    case "arxiv":
      return searchArxiv(query);

    case "news": {
      // RSS + Reddit (when location matches). Reddit's credibility
      // is lower so RSS naturally outranks in the reporter; we just
      // want the community signal in the mix.
      const [rss, red] = await Promise.all([
        searchNews(query),
        redditProvider.search(query),
      ]);
      return [...rss, ...red].slice(0, query.maxResults * 2);
    }

    case "ai_updates": {
      const [chainHits, redHits] = await Promise.all([
        runChain(query).then((c) => c.results),
        redditProvider.search(query),
      ]);
      return [...chainHits, ...redHits].slice(0, query.maxResults * 2);
    }

    case "crawl":
    case "general":
    default: {
      const { results } = await runChain(query);
      return results;
    }
  }
}
