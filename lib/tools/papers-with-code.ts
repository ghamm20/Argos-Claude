// lib/tools/papers-with-code.ts — T23 papers_with_code (web, safe, keyless)
//
// Papers With Code API — papers linked to code + SOTA. Searches papers, returns
// each with its repository (stars) when available. 24h cache. Tolerant of the
// API's varying shapes (degrades to what it can parse).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "papers_with_code";
const TTL = 24 * 60 * 60 * 1000;

interface PwcPaper {
  id?: string;
  title?: string;
  abstract?: string;
  url_abs?: string;
  url_pdf?: string;
  published?: string;
}
interface PwcRepo {
  url?: string;
  stars?: number;
  framework?: string;
}
interface PwcSearchItem {
  paper?: PwcPaper;
  repository?: PwcRepo;
  is_official?: boolean;
  // some endpoints return a bare paper
  title?: string;
  url_abs?: string;
}
interface PwcResp {
  count?: number;
  results?: PwcSearchItem[];
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const url = `https://paperswithcode.com/api/v1/search/?q=${encodeURIComponent(q)}`;
  const r = await webFetchJson<PwcResp>({ source: "papers_with_code", op: "search", url, query: q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, r.error ?? "Papers With Code request failed");

  const items = (r.data?.results ?? []).slice(0, 10).map((it) => {
    const p = it.paper ?? { title: it.title, url_abs: it.url_abs };
    return {
      title: p.title ?? "(untitled)",
      abstract: (p.abstract ?? "").slice(0, 600),
      paperUrl: p.url_abs ?? null,
      pdfUrl: p.url_pdf ?? null,
      published: p.published ?? null,
      repoUrl: it.repository?.url ?? null,
      stars: it.repository?.stars ?? null,
      framework: it.repository?.framework ?? null,
      official: it.is_official ?? null,
    };
  });
  if (items.length === 0) return toolErr(ID, "no Papers With Code results");
  return toolOk(ID, `Papers With Code: ${items.length} result(s) for "${q}"`, {
    data: { query: q, total: r.data?.count ?? items.length, results: items, fromCache: r.fromCache },
    sources: items.map((i) => i.repoUrl ?? i.paperUrl).filter((u): u is string => !!u).slice(0, 10),
  });
};
