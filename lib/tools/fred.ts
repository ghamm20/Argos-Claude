// lib/tools/fred.ts — T55 fred (web, safe, KEYED — graceful skip)
//
// FRED (St. Louis Fed) — US economic time series. Two modes:
//   `series_id` → latest observations   |   `query` → series search.
// Free key at fredaccount.stlouisfed.org (Settings → API keys → fred). No key →
// honest "not configured".

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson, getApiKey } from "../web";

export const ID = "fred";
const TTL = 6 * 60 * 60 * 1000; // 6h

interface Obs { date?: string; value?: string }
interface ObsResp { observations?: Obs[]; count?: number }
interface Series { id?: string; title?: string; frequency?: string; units?: string; observation_end?: string }
interface SearchResp { seriess?: Series[] }

export const execute: ToolExecute = async (params) => {
  const key = await getApiKey("fred");
  if (!key) {
    return toolOk(ID, "FRED is not configured — add a FRED API key (free at fredaccount.stlouisfed.org) in Settings → API keys.", { data: { configured: false } });
  }
  const seriesId = String(params.series_id ?? params.seriesId ?? "").trim();
  const q = String(params.query ?? "").trim();
  if (seriesId) {
    const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 24) : 12;
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=${limit}`;
    const r = await webFetchJson<ObsResp>({ source: "fred", op: "observations", url, query: seriesId, ttlMs: TTL, timeoutMs: 20000 });
    if (!r.ok) {
      if (r.status === 400) return toolErr(ID, `FRED rejected the request (400) — check series_id "${seriesId}" / the API key.`);
      return toolErr(ID, `FRED request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
    }
    const obs = (r.data?.observations ?? []).map((o) => ({ date: o.date ?? null, value: o.value ?? null })).filter((o) => o.value && o.value !== ".");
    if (obs.length === 0) return toolErr(ID, `FRED returned no observations for series ${seriesId}`);
    return toolOk(ID, `FRED ${seriesId}: latest ${obs[0]?.value} (${obs[0]?.date}), ${obs.length} obs`, { data: { configured: true, seriesId, observations: obs } });
  }
  if (q) {
    const url = `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}&file_type=json&limit=10`;
    const r = await webFetchJson<SearchResp>({ source: "fred", op: "search", url, query: q, ttlMs: TTL, timeoutMs: 20000 });
    if (!r.ok) return toolErr(ID, `FRED search failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
    const series = (r.data?.seriess ?? []).slice(0, 10).map((s) => ({ id: s.id ?? null, title: s.title ?? null, frequency: s.frequency ?? null, units: s.units ?? null, lastObs: s.observation_end ?? null }));
    if (series.length === 0) return toolErr(ID, `FRED found no series for "${q}"`);
    return toolOk(ID, `FRED: ${series.length} series matched "${q}" — query a series_id for its data`, { data: { configured: true, query: q, series } });
  }
  return toolErr(ID, "provide a `series_id` (e.g. CPIAUCSL) for data, or a `query` to search series");
};
