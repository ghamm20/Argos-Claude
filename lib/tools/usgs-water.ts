// lib/tools/usgs-water.ts — T39 usgs_water (web, safe, keyless)
//
// USGS Instantaneous Values (NWIS) — current streamflow + gage height.
// https://waterservices.usgs.gov/nwis/iv/ (keyless). Default state: Tennessee.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "usgs_water";
const TTL = 30 * 60 * 1000; // 30m (near-real-time data)

interface TsValue { value?: Array<{ value?: string; dateTime?: string }> }
interface TimeSeries {
  sourceInfo?: { siteName?: string; siteCode?: Array<{ value?: string }> };
  variable?: { variableName?: string; unit?: { unitCode?: string } };
  values?: TsValue[];
}
interface UsgsResp { value?: { timeSeries?: TimeSeries[] } }

export const execute: ToolExecute = async (params) => {
  const site = String(params.site ?? "").trim();
  const stateCd = String(params.stateCd ?? params.state ?? "tn").trim().toLowerCase();
  const paramCd = String(params.parameterCd ?? "00060,00065").trim(); // discharge + gage height
  const selector = site
    ? `sites=${encodeURIComponent(site)}`
    : `stateCd=${encodeURIComponent(stateCd)}`;
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&${selector}&parameterCd=${encodeURIComponent(paramCd)}&siteStatus=active`;

  const r = await webFetchJson<UsgsResp>({ source: "usgs", op: "water", url, query: site || stateCd, ttlMs: TTL, timeoutMs: 20000 });
  if (!r.ok) return toolErr(ID, `USGS water request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const ts = (r.data?.value?.timeSeries ?? []).slice(0, 30).map((t) => {
    const latest = t.values?.[0]?.value?.[0];
    return {
      site: t.sourceInfo?.siteCode?.[0]?.value ?? null,
      name: t.sourceInfo?.siteName ?? null,
      variable: t.variable?.variableName ?? null,
      unit: t.variable?.unit?.unitCode ?? null,
      latestValue: latest?.value ?? null,
      at: latest?.dateTime ?? null,
    };
  });
  if (ts.length === 0) return toolErr(ID, `USGS returned no active gauges for ${site ? `site ${site}` : `state ${stateCd.toUpperCase()}`}`);
  return toolOk(ID, `USGS water: ${ts.length} active gauge reading(s) for ${site ? `site ${site}` : stateCd.toUpperCase()}`, {
    data: { selector: site || stateCd, gauges: ts, fromCache: r.fromCache },
  });
};
