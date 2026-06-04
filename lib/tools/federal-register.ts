// lib/tools/federal-register.ts — T38 federal_register (web, safe, keyless)
//
// Federal Register API v1 — rules, proposed rules, notices, executive orders.
// https://www.federalregister.gov/api/v1/documents.json (keyless).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "federal_register";
const TTL = 3 * 60 * 60 * 1000; // 3h

interface FrDoc {
  document_number?: string;
  title?: string;
  type?: string;
  abstract?: string;
  publication_date?: string;
  agencies?: Array<{ name?: string }>;
  html_url?: string;
}
interface FrResp { count?: number; results?: FrDoc[] }

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? params.term ?? "").trim();
  if (!q) return toolErr(ID, "query (search term) is required");
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 20) : 8;
  const fields = ["document_number", "title", "type", "abstract", "publication_date", "agencies", "html_url"]
    .map((f) => `fields[]=${f}`)
    .join("&");
  const url = `https://www.federalregister.gov/api/v1/documents.json?conditions[term]=${encodeURIComponent(q)}&per_page=${limit}&order=newest&${fields}`;

  const r = await webFetchJson<FrResp>({ source: "federal_register", op: "search", url, query: q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, `Federal Register request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const docs = (r.data?.results ?? []).map((d) => ({
    documentNumber: d.document_number ?? null,
    title: d.title ?? "(untitled)",
    type: d.type ?? null,
    date: d.publication_date ?? null,
    agencies: (d.agencies ?? []).map((a) => a.name ?? "").filter(Boolean),
    abstract: d.abstract?.slice(0, 400) ?? null,
    url: d.html_url ?? null,
  }));
  if (docs.length === 0) return toolErr(ID, `no Federal Register documents matched "${q}" (0 results)`);
  return toolOk(ID, `Federal Register: ${docs.length} document(s) for "${q}" (of ${r.data?.count ?? docs.length})`, {
    data: { query: q, total: r.data?.count ?? docs.length, documents: docs, fromCache: r.fromCache },
    sources: docs.map((d) => d.url).filter((u): u is string => !!u),
  });
};
