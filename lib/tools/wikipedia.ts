// lib/tools/wikipedia.ts — T19 wikipedia_search (web, safe, keyless)
//
// Two-step: MediaWiki search → full plain-text extract of the top hit. Returns
// title, summary, fullText, url, lastModified. 24h cache. Routes through
// lib/web (Rule-4 safe: URL is a value).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "wikipedia_search";
const TTL = 24 * 60 * 60 * 1000;
const API = "https://en.wikipedia.org/w/api.php";

interface WikiSearch {
  query?: { search?: Array<{ title: string; pageid: number; snippet: string }> };
}
interface WikiExtract {
  query?: {
    pages?: Record<string, { title?: string; extract?: string; fullurl?: string; touched?: string }>;
  };
}

const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");

  const searchUrl = `${API}?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(q)}`;
  const s = await webFetchJson<WikiSearch>({ source: "wikipedia", op: "search", url: searchUrl, query: q, ttlMs: TTL });
  const hits = s.data?.query?.search ?? [];
  if (!s.ok || hits.length === 0) return toolErr(ID, s.error ?? "no Wikipedia results");

  const top = hits[0];
  const exUrl = `${API}?action=query&prop=extracts%7Cinfo&explaintext=1&inprop=url&format=json&pageids=${top.pageid}`;
  const e = await webFetchJson<WikiExtract>({ source: "wikipedia", op: "extract", url: exUrl, query: top.title, ttlMs: TTL });
  const page = e.data?.query?.pages?.[String(top.pageid)];
  const full = page?.extract ?? "";
  const summary = full ? full.split("\n").find(Boolean)?.slice(0, 600) ?? "" : strip(top.snippet);
  const url = page?.fullurl ?? `https://en.wikipedia.org/?curid=${top.pageid}`;

  return toolOk(ID, `Wikipedia: ${top.title}`, {
    data: {
      title: top.title,
      summary,
      fullText: full.slice(0, 8000),
      url,
      lastModified: page?.touched ?? null,
      related: hits.slice(1, 5).map((h) => ({ title: h.title, snippet: strip(h.snippet) })),
      fromCache: s.fromCache,
    },
    sources: [url],
  });
};
