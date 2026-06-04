// lib/tools/internet-archive.ts — T44 internet_archive (web, safe, keyless)
//
// Internet Archive advanced search — texts, audio, video, software, web.
// https://archive.org/advancedsearch.php (keyless).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "internet_archive";
const TTL = 6 * 60 * 60 * 1000; // 6h

interface IaDoc {
  identifier?: string;
  title?: string;
  creator?: string | string[];
  year?: string;
  mediatype?: string;
  downloads?: number;
}
interface IaResp { response?: { numFound?: number; docs?: IaDoc[] } }

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 25) : 10;
  const mediatype = String(params.mediatype ?? "").trim();
  const qFull = mediatype ? `${q} AND mediatype:(${mediatype})` : q;
  const fl = ["identifier", "title", "creator", "year", "mediatype", "downloads"].map((f) => `fl[]=${f}`).join("&");
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(qFull)}&${fl}&sort[]=downloads desc&rows=${limit}&page=1&output=json`;

  const r = await webFetchJson<IaResp>({ source: "internet_archive", op: "search", url, query: q, ttlMs: TTL, timeoutMs: 20000 });
  if (!r.ok) return toolErr(ID, `Internet Archive request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const docs = (r.data?.response?.docs ?? []).map((d) => ({
    identifier: d.identifier ?? null,
    title: d.title ?? "(untitled)",
    creator: Array.isArray(d.creator) ? d.creator.join(", ") : d.creator ?? null,
    year: d.year ?? null,
    mediatype: d.mediatype ?? null,
    downloads: d.downloads ?? null,
    url: d.identifier ? `https://archive.org/details/${d.identifier}` : null,
  }));
  if (docs.length === 0) return toolErr(ID, `Internet Archive found 0 items for "${q}"`);
  return toolOk(ID, `Internet Archive: ${docs.length} item(s) for "${q}" (of ${r.data?.response?.numFound ?? docs.length})`, {
    data: { query: q, total: r.data?.response?.numFound ?? docs.length, items: docs, fromCache: r.fromCache },
    sources: docs.map((d) => d.url).filter((u): u is string => !!u),
  });
};
