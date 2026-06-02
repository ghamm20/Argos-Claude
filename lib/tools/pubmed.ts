// lib/tools/pubmed.ts — T26 pubmed_search (web, safe, keyless)
//
// NCBI E-utilities: esearch (ids) → esummary (metadata). Medical/biological
// literature. The pubmed rate bucket honors NCBI's ~3/sec courtesy limit.
// Returns papers with title, journal, pubdate, authors, PMID. 24h cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "pubmed_search";
const TTL = 24 * 60 * 60 * 1000;
const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL_TAG = "argos"; // NCBI asks tools to identify themselves

interface ESearch {
  esearchresult?: { idlist?: string[]; count?: string };
}
interface ESummaryDoc {
  uid?: string;
  title?: string;
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  authors?: Array<{ name?: string }>;
}
interface ESummary {
  result?: Record<string, ESummaryDoc | string[]> & { uids?: string[] };
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const retmax = typeof params.maxResults === "number" ? Math.min(Math.max(1, params.maxResults), 20) : 10;

  const sUrl = `${BASE}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}&tool=${TOOL_TAG}&term=${encodeURIComponent(q)}`;
  const s = await webFetchJson<ESearch>({ source: "pubmed", op: "esearch", url: sUrl, query: q, ttlMs: TTL });
  const ids = s.data?.esearchresult?.idlist ?? [];
  if (!s.ok || ids.length === 0) return toolErr(ID, s.error ?? "no PubMed results");

  const sumUrl = `${BASE}/esummary.fcgi?db=pubmed&retmode=json&tool=${TOOL_TAG}&id=${ids.join(",")}`;
  const sum = await webFetchJson<ESummary>({ source: "pubmed", op: "esummary", url: sumUrl, query: q, ttlMs: TTL });
  const result = sum.data?.result;
  const papers = ids
    .map((id) => result?.[id])
    .filter((d): d is ESummaryDoc => !!d && typeof d === "object" && !Array.isArray(d))
    .map((d) => ({
      pmid: d.uid ?? "",
      title: d.title ?? "(untitled)",
      journal: d.fulljournalname ?? d.source ?? null,
      pubdate: d.pubdate ?? null,
      authors: (d.authors ?? []).slice(0, 6).map((a) => a.name ?? "").filter(Boolean),
      url: d.uid ? `https://pubmed.ncbi.nlm.nih.gov/${d.uid}/` : null,
    }));
  if (papers.length === 0) return toolErr(ID, "PubMed returned ids but no summaries");
  return toolOk(ID, `PubMed: ${papers.length} paper(s) for "${q}"`, {
    data: { query: q, total: Number(s.data?.esearchresult?.count ?? papers.length), papers, fromCache: sum.fromCache },
    sources: papers.map((p) => p.url).filter((u): u is string => !!u).slice(0, 10),
  });
};
