// lib/tools/crossref.ts — T25 crossref_lookup (web, safe, keyless)
//
// Crossref works search — academic metadata + DOI resolution. Polite pool via
// &mailto=. Returns papers with title, authors, DOI, container, year, citations.
// 24h cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "crossref_lookup";
const TTL = 24 * 60 * 60 * 1000;
const MAILTO = "argos-operator@localhost"; // Crossref polite-pool contact (no PII)

interface CrItem {
  title?: string[];
  author?: Array<{ given?: string; family?: string }>;
  DOI?: string;
  "container-title"?: string[];
  published?: { "date-parts"?: number[][] };
  "is-referenced-by-count"?: number;
  type?: string;
  URL?: string;
}
interface CrResp {
  message?: { items?: CrItem[]; "total-results"?: number };
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  const doi = typeof params.doi === "string" ? params.doi.trim() : "";
  if (!q && !doi) return toolErr(ID, "query or doi is required");

  const url = doi
    ? `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`
    : `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=10&mailto=${encodeURIComponent(MAILTO)}`;

  const r = await webFetchJson<CrResp | { message?: CrItem }>({ source: "crossref", op: doi ? "doi" : "search", url, query: doi || q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, r.error ?? "Crossref request failed");

  const rawItems: CrItem[] = doi
    ? [((r.data as { message?: CrItem })?.message ?? {}) as CrItem]
    : ((r.data as CrResp)?.message?.items ?? []);
  const items = rawItems
    .filter((it) => it && (it.title?.length || it.DOI))
    .slice(0, 10)
    .map((it) => ({
      title: it.title?.[0] ?? "(untitled)",
      authors: (it.author ?? []).slice(0, 6).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
      doi: it.DOI ?? null,
      url: it.URL ?? (it.DOI ? `https://doi.org/${it.DOI}` : null),
      container: it["container-title"]?.[0] ?? null,
      year: it.published?.["date-parts"]?.[0]?.[0] ?? null,
      citations: it["is-referenced-by-count"] ?? 0,
      type: it.type ?? null,
    }));
  if (items.length === 0) return toolErr(ID, "no Crossref results");
  return toolOk(ID, `Crossref: ${items.length} result(s) for "${doi || q}"`, {
    data: { query: doi || q, results: items, fromCache: r.fromCache },
    sources: items.map((i) => i.url).filter((u): u is string => !!u).slice(0, 10),
  });
};
