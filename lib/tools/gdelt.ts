// lib/tools/gdelt.ts — T27 gdelt_events (web, safe, keyless)
//
// GDELT 2.0 DOC API — global news/event monitoring. Filter by query, timespan,
// and (optional) source country. Returns recent articles with domain, country,
// language, seen-date, image. 1h cache (news moves fast).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "gdelt_events";
const TTL = 60 * 60 * 1000;

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  sourcecountry?: string;
  language?: string;
  socialimage?: string;
}
interface GdeltResp {
  articles?: GdeltArticle[];
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const timespan = typeof params.timespan === "string" && /^\d+[hdwm]$/i.test(params.timespan) ? params.timespan : "1d";
  const maxrecords = typeof params.maxResults === "number" ? Math.min(Math.max(1, params.maxResults), 50) : 20;
  let query = q;
  if (typeof params.country === "string" && params.country.trim()) {
    query += ` sourcecountry:${params.country.trim().toUpperCase()}`;
  }
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&format=json&maxrecords=${maxrecords}&sort=DateDesc&timespan=${timespan}`;

  const r = await webFetchJson<GdeltResp>({ source: "gdelt", op: "artlist", url, query: q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, r.error ?? "GDELT request failed");
  const articles = (r.data?.articles ?? []).slice(0, maxrecords).map((a) => ({
    title: a.title ?? "(untitled)",
    url: a.url ?? null,
    domain: a.domain ?? null,
    country: a.sourcecountry ?? null,
    language: a.language ?? null,
    seenDate: a.seendate ?? null,
    image: a.socialimage ?? null,
  }));
  if (articles.length === 0) return toolErr(ID, "no GDELT articles in window");
  return toolOk(ID, `GDELT: ${articles.length} article(s) for "${q}" (${timespan})`, {
    data: { query: q, timespan, articles, fromCache: r.fromCache },
    sources: articles.map((a) => a.url).filter((u): u is string => !!u).slice(0, 10),
  });
};
