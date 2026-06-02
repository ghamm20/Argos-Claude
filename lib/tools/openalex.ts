// lib/tools/openalex.ts — T22 openalex_search (web, safe, keyless)
//
// OpenAlex works search — OA papers, citation counts, authors, institutions.
// Polite pool via &mailto= (no PII; a generic contact). 24h cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "openalex_search";
const TTL = 24 * 60 * 60 * 1000;
const MAILTO = "argos-operator@localhost"; // OpenAlex polite-pool contact (no PII)

interface OAWork {
  id?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  doi?: string;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  authorships?: Array<{
    author?: { display_name?: string };
    institutions?: Array<{ display_name?: string }>;
  }>;
  primary_location?: { source?: { display_name?: string }; landing_page_url?: string };
}
interface OAResp {
  results?: OAWork[];
  meta?: { count?: number };
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const perPage = typeof params.maxResults === "number" ? Math.min(Math.max(1, params.maxResults), 25) : 10;
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=${perPage}&mailto=${encodeURIComponent(MAILTO)}`;

  const r = await webFetchJson<OAResp>({ source: "openalex", op: "search", url, query: q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, r.error ?? "OpenAlex request failed");
  const works = (r.data?.results ?? []).map((w) => ({
    title: w.title ?? w.display_name ?? "(untitled)",
    year: w.publication_year ?? null,
    citations: w.cited_by_count ?? 0,
    doi: w.doi ?? null,
    openAccess: !!w.open_access?.is_oa,
    oaUrl: w.open_access?.oa_url ?? null,
    authors: (w.authorships ?? []).slice(0, 6).map((a) => a.author?.display_name ?? "").filter(Boolean),
    institutions: Array.from(
      new Set((w.authorships ?? []).flatMap((a) => (a.institutions ?? []).map((i) => i.display_name ?? "")))
    ).filter(Boolean).slice(0, 5),
    venue: w.primary_location?.source?.display_name ?? null,
    url: w.primary_location?.landing_page_url ?? (w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi.org\//, "")}` : null),
  }));
  if (works.length === 0) return toolErr(ID, "no OpenAlex works matched");
  return toolOk(ID, `OpenAlex: ${works.length} work(s) for "${q}"`, {
    data: { query: q, total: r.data?.meta?.count ?? works.length, works, fromCache: r.fromCache },
    sources: works.map((w) => w.url).filter((u): u is string => !!u).slice(0, 10),
  });
};
