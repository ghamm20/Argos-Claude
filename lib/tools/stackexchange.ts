// lib/tools/stackexchange.ts — T30 stackexchange_search (web, safe, keyless)
//
// Stack Exchange API 2.3 advanced search across Stack Overflow + sister sites
// (300 req/day per IP, no key). Returns questions with score, answer status,
// accepted-answer flag, tags, link. 6h cache. (The API gzips responses; the
// http client's fetch transparently decompresses.)

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "stackexchange_search";
const TTL = 6 * 60 * 60 * 1000;

interface SeItem {
  title?: string;
  link?: string;
  score?: number;
  is_answered?: boolean;
  answer_count?: number;
  accepted_answer_id?: number;
  view_count?: number;
  tags?: string[];
  creation_date?: number;
}
interface SeResp {
  items?: SeItem[];
  quota_remaining?: number;
  has_more?: boolean;
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const site = typeof params.site === "string" && params.site.trim() ? params.site.trim() : "stackoverflow";
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}` +
    `&site=${encodeURIComponent(site)}&pagesize=15&filter=default`;

  const r = await webFetchJson<SeResp>({ source: "stackexchange", op: "search", url, query: q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, r.error ?? "Stack Exchange request failed");
  const items = (r.data?.items ?? []).slice(0, 15).map((it) => ({
    title: (it.title ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
    url: it.link ?? "",
    score: it.score ?? 0,
    answered: !!it.is_answered,
    answers: it.answer_count ?? 0,
    accepted: it.accepted_answer_id != null,
    views: it.view_count ?? 0,
    tags: (it.tags ?? []).slice(0, 6),
  }));
  if (items.length === 0) return toolErr(ID, "no Stack Exchange results");
  return toolOk(ID, `Stack Exchange (${site}): ${items.length} question(s) for "${q}"`, {
    data: { query: q, site, results: items, quotaRemaining: r.data?.quota_remaining ?? null, fromCache: r.fromCache },
    sources: items.map((i) => i.url).filter(Boolean).slice(0, 10),
  });
};
