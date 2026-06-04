// lib/tools/sam-gov.ts — T52 sam_gov (web, safe, KEYED — graceful skip)
//
// api.sam.gov Opportunities v2 — federal contract opportunities. Free key via
// api.data.gov (Settings → API keys → sam_gov). No key → honest "not configured".
// Requires a posted-date window (defaults to the last 30 days).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson, getApiKey } from "../web";

export const ID = "sam_gov";
const TTL = 60 * 60 * 1000; // 1h

interface Opp { title?: string; solicitationNumber?: string; type?: string; postedDate?: string; responseDeadLine?: string; uiLink?: string; fullParentPathName?: string }
interface OppResp { totalRecords?: number; opportunitiesData?: Opp[] }

function mmddyyyy(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

export const execute: ToolExecute = async (params) => {
  const key = await getApiKey("sam_gov");
  if (!key) {
    return toolOk(ID, "sam.gov is not configured — add a SAM.gov API key (free at api.data.gov) in Settings → API keys.", { data: { configured: false } });
  }
  const q = String(params.query ?? params.q ?? "").trim();
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 25) : 10;
  // Date window: caller-provided MM/DD/YYYY, else last 30 days. (Stamp here is
  // fine — tool runtime, not a cached/replayed workflow.)
  const to = String(params.postedTo ?? mmddyyyy(new Date())).trim();
  const from = String(params.postedFrom ?? mmddyyyy(new Date(Date.now() - 30 * 86400_000))).trim();
  const qp = q ? `&title=${encodeURIComponent(q)}` : "";
  const url = `https://api.sam.gov/opportunities/v2/search?api_key=${encodeURIComponent(key)}&limit=${limit}&postedFrom=${encodeURIComponent(from)}&postedTo=${encodeURIComponent(to)}${qp}`;

  const r = await webFetchJson<OppResp>({ source: "sam_gov", op: "opportunities", url, query: q || `${from}-${to}`, ttlMs: TTL, timeoutMs: 25000 });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return toolErr(ID, `sam.gov rejected the API key (HTTP ${r.status}) — check the key in Settings.`);
    return toolErr(ID, `sam.gov request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  }
  const opps = (r.data?.opportunitiesData ?? []).map((o) => ({ title: o.title ?? null, solicitation: o.solicitationNumber ?? null, type: o.type ?? null, posted: o.postedDate ?? null, deadline: o.responseDeadLine ?? null, org: o.fullParentPathName ?? null, url: o.uiLink ?? null }));
  if (opps.length === 0) return toolErr(ID, `sam.gov returned 0 opportunities for ${q || `${from}–${to}`}`);
  return toolOk(ID, `sam.gov: ${opps.length} opportunity(ies)${q ? ` for "${q}"` : ""} (of ${r.data?.totalRecords ?? opps.length})`, { data: { configured: true, window: `${from}–${to}`, total: r.data?.totalRecords ?? opps.length, opportunities: opps }, sources: opps.map((o) => o.url).filter((u): u is string => !!u) });
};
