// lib/tools/noaa-climate.ts — T54 noaa_climate (web, safe, KEYED — graceful skip)
//
// NOAA NCEI Climate Data Online (CDO) v2 — climate observations. Free token at
// ncdc.noaa.gov/cdo-web/token (Settings → API keys → noaa_cdo). No token →
// honest "not configured".

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson, getApiKey } from "../web";

export const ID = "noaa_climate";
const TTL = 6 * 60 * 60 * 1000; // 6h

interface CdoResult { date?: string; datatype?: string; station?: string; value?: number; attributes?: string }
interface CdoResp { results?: CdoResult[]; metadata?: { resultset?: { count?: number } } }

export const execute: ToolExecute = async (params) => {
  const key = await getApiKey("noaa_cdo");
  if (!key) {
    return toolOk(ID, "NOAA climate (NCEI CDO) is not configured — add a CDO token (free at ncdc.noaa.gov/cdo-web/token) in Settings → API keys.", { data: { configured: false } });
  }
  const datasetid = String(params.datasetid ?? "GHCND").trim();
  const stationid = String(params.stationid ?? "").trim();
  const locationid = String(params.locationid ?? "").trim();
  const startdate = String(params.startdate ?? "").trim();
  const enddate = String(params.enddate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startdate) || !/^\d{4}-\d{2}-\d{2}$/.test(enddate)) {
    return toolErr(ID, "startdate and enddate are required as YYYY-MM-DD");
  }
  if (!stationid && !locationid) return toolErr(ID, "provide a `stationid` (e.g. GHCND:USW00013897) or `locationid` (e.g. FIPS:47 for Tennessee)");
  const parts = [`datasetid=${encodeURIComponent(datasetid)}`, `startdate=${startdate}`, `enddate=${enddate}`, "limit=25", "units=standard"];
  if (stationid) parts.push(`stationid=${encodeURIComponent(stationid)}`);
  if (locationid) parts.push(`locationid=${encodeURIComponent(locationid)}`);
  const url = `https://www.ncdc.noaa.gov/cdo-web/api/v2/data?${parts.join("&")}`;

  const r = await webFetchJson<CdoResp>({ source: "noaa_cdo", op: "data", url, query: stationid || locationid, ttlMs: TTL, headers: { token: key }, timeoutMs: 25000 });
  if (!r.ok) {
    if (r.status === 400) return toolErr(ID, "NOAA CDO rejected the request (400) — check datasetid/station/date range.");
    if (r.status === 401 || r.status === 403) return toolErr(ID, `NOAA CDO rejected the token (HTTP ${r.status}) — check the key in Settings.`);
    return toolErr(ID, `NOAA CDO request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  }
  const obs = (r.data?.results ?? []).map((o) => ({ date: o.date ?? null, type: o.datatype ?? null, station: o.station ?? null, value: o.value ?? null }));
  if (obs.length === 0) return toolErr(ID, `NOAA CDO returned 0 observations for ${stationid || locationid} (${startdate}–${enddate})`);
  return toolOk(ID, `NOAA climate: ${obs.length} observation(s) for ${stationid || locationid} (${startdate}–${enddate})`, { data: { configured: true, dataset: datasetid, count: obs.length, observations: obs } });
};
