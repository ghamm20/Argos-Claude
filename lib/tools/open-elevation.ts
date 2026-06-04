// lib/tools/open-elevation.ts — T43 open_elevation (web, safe, keyless)
//
// Open-Elevation — terrain elevation for one or more lat/lon points.
// https://api.open-elevation.com/api/v1/lookup (keyless).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "open_elevation";
const TTL = 30 * 24 * 60 * 60 * 1000; // 30d (elevation doesn't change)

interface ElevResp { results?: Array<{ latitude?: number; longitude?: number; elevation?: number }> }

export const execute: ToolExecute = async (params) => {
  // Accept lat+lon, or a `locations` string "lat,lon|lat,lon".
  let locations = String(params.locations ?? "").trim();
  if (!locations && typeof params.lat === "number" && typeof params.lon === "number") {
    locations = `${params.lat},${params.lon}`;
  }
  if (!locations || !/^\s*-?\d+(\.\d+)?,-?\d+(\.\d+)?(\s*\|\s*-?\d+(\.\d+)?,-?\d+(\.\d+)?)*\s*$/.test(locations)) {
    return toolErr(ID, "provide numeric `lat`+`lon`, or `locations` as \"lat,lon|lat,lon\"");
  }
  const url = `https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(locations)}`;

  const r = await webFetchJson<ElevResp>({ source: "open_elevation", op: "lookup", url, query: locations, ttlMs: TTL, timeoutMs: 20000 });
  if (!r.ok) return toolErr(ID, `Open-Elevation request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const pts = (r.data?.results ?? []).map((p) => ({ lat: p.latitude ?? null, lon: p.longitude ?? null, elevationM: p.elevation ?? null }));
  if (pts.length === 0) return toolErr(ID, "Open-Elevation returned no results");
  return toolOk(ID, `Open-Elevation: ${pts.length} point(s) — ${pts.map((p) => `${p.elevationM}m`).join(", ").slice(0, 80)}`, {
    data: { points: pts, fromCache: r.fromCache },
  });
};
