// lib/tools/usda-nass.ts — T53 usda_nass (web, safe, KEYED — graceful skip)
//
// USDA NASS QuickStats — agricultural statistics. Free key at
// quickstats.nass.usda.gov/api (Settings → API keys → usda_nass). No key →
// honest "not configured". Default state: Tennessee.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson, getApiKey } from "../web";

export const ID = "usda_nass";
const TTL = 24 * 60 * 60 * 1000; // 24h

interface NassRow { commodity_desc?: string; statisticcat_desc?: string; Value?: string; unit_desc?: string; year?: string; state_alpha?: string; short_desc?: string }
interface NassResp { data?: NassRow[]; error?: string[] }

export const execute: ToolExecute = async (params) => {
  const key = await getApiKey("usda_nass");
  if (!key) {
    return toolOk(ID, "USDA NASS is not configured — add a QuickStats API key (free at quickstats.nass.usda.gov/api) in Settings → API keys.", { data: { configured: false } });
  }
  const commodity = String(params.commodity ?? params.commodity_desc ?? "CORN").trim().toUpperCase();
  const state = String(params.state ?? params.state_alpha ?? "TN").trim().toUpperCase();
  const year = String(params.year ?? "").trim();
  const parts = [`key=${encodeURIComponent(key)}`, `commodity_desc=${encodeURIComponent(commodity)}`, `state_alpha=${encodeURIComponent(state)}`, "format=JSON"];
  if (/^\d{4}$/.test(year)) parts.push(`year=${year}`);
  const url = `https://quickstats.nass.usda.gov/api/api_GET/?${parts.join("&")}`;

  const r = await webFetchJson<NassResp>({ source: "usda_nass", op: "quickstats", url, query: `${commodity} ${state} ${year}`, ttlMs: TTL, timeoutMs: 25000 });
  if (!r.ok) {
    if (r.status === 401) return toolErr(ID, "USDA NASS rejected the API key (401) — check the key in Settings.");
    return toolErr(ID, `USDA NASS request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  }
  if (r.data?.error?.length) return toolErr(ID, `USDA NASS: ${r.data.error.join("; ")}`);
  const rows = (r.data?.data ?? []).slice(0, 15).map((d) => ({ desc: d.short_desc ?? d.commodity_desc ?? null, value: d.Value ?? null, unit: d.unit_desc ?? null, year: d.year ?? null, state: d.state_alpha ?? null }));
  if (rows.length === 0) return toolErr(ID, `USDA NASS returned 0 rows for ${commodity} in ${state}${year ? ` (${year})` : ""}`);
  return toolOk(ID, `USDA NASS: ${rows.length} stat(s) for ${commodity} in ${state}${year ? ` (${year})` : ""}`, { data: { configured: true, commodity, state, count: rows.length, rows } });
};
