// lib/tools/wikidata.ts — T20 wikidata_query (web, safe, keyless)
//
// Two modes:
//   - params.sparql  → run a SPARQL query against query.wikidata.org
//   - params.query   → resolve an entity (wbsearchentities) + return its label,
//                      description, aliases, and top claims (structured)
// 24h cache. Routes through lib/web.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "wikidata_query";
const TTL = 24 * 60 * 60 * 1000;

interface SearchResp {
  search?: Array<{ id: string; label?: string; description?: string }>;
}
interface SparqlResp {
  results?: { bindings?: Array<Record<string, { value: string }>> };
  head?: { vars?: string[] };
}
interface EntityData {
  entities?: Record<
    string,
    {
      labels?: Record<string, { value: string }>;
      descriptions?: Record<string, { value: string }>;
      aliases?: Record<string, Array<{ value: string }>>;
      claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
    }
  >;
}

function claimValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string") return o.id; // entity reference (Q…)
    if (typeof o.time === "string") return o.time;
    if (typeof o.amount === "string") return o.amount;
    if (typeof o.text === "string") return o.text;
  }
  return JSON.stringify(v).slice(0, 80);
}

export const execute: ToolExecute = async (params) => {
  const sparql = typeof params.sparql === "string" ? params.sparql.trim() : "";
  const q = String(params.query ?? "").trim();

  // --- SPARQL mode ---
  if (sparql) {
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const r = await webFetchJson<SparqlResp>({
      source: "wikidata",
      op: "sparql",
      url,
      query: sparql.slice(0, 120),
      ttlMs: TTL,
      headers: { accept: "application/sparql-results+json" },
    });
    if (!r.ok) return toolErr(ID, r.error ?? "SPARQL query failed");
    const rows = (r.data?.results?.bindings ?? []).slice(0, 25).map((b) => {
      const out: Record<string, string> = {};
      for (const k of Object.keys(b)) out[k] = b[k]?.value ?? "";
      return out;
    });
    return toolOk(ID, `Wikidata SPARQL: ${rows.length} row(s)`, {
      data: { mode: "sparql", vars: r.data?.head?.vars ?? [], rows },
    });
  }

  // --- Entity mode ---
  if (!q) return toolErr(ID, "query or sparql is required");
  const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json&limit=5`;
  const s = await webFetchJson<SearchResp>({ source: "wikidata", op: "search", url: sUrl, query: q, ttlMs: TTL });
  const ent = s.data?.search ?? [];
  if (!s.ok || ent.length === 0) return toolErr(ID, s.error ?? "no Wikidata entity found");

  const top = ent[0];
  const dUrl = `https://www.wikidata.org/wiki/Special:EntityData/${top.id}.json`;
  const d = await webFetchJson<EntityData>({ source: "wikidata", op: "entity", url: dUrl, query: top.id, ttlMs: TTL });
  const e = d.data?.entities?.[top.id];
  const label = e?.labels?.en?.value ?? top.label ?? top.id;
  const description = e?.descriptions?.en?.value ?? top.description ?? "";
  const aliases = (e?.aliases?.en ?? []).map((a) => a.value).slice(0, 8);
  const claims: Array<{ property: string; values: string[] }> = [];
  for (const [prop, arr] of Object.entries(e?.claims ?? {})) {
    const vals = arr.slice(0, 3).map((c) => claimValue(c.mainsnak?.datavalue?.value)).filter(Boolean);
    if (vals.length) claims.push({ property: prop, values: vals });
    if (claims.length >= 20) break;
  }
  const url = `https://www.wikidata.org/wiki/${top.id}`;
  return toolOk(ID, `Wikidata: ${label} (${top.id})`, {
    data: { mode: "entity", id: top.id, label, description, aliases, claims, url, candidates: ent.slice(1, 5) },
    sources: [url],
  });
};
