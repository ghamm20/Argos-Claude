// lib/tools/overpass-osm.ts — T42 overpass_osm (web, safe, keyless)
//
// OpenStreetMap Overpass API — query map features. Two modes:
//   1. raw `ql` (Overpass QL) for power users.
//   2. `amenity` near `lat`,`lon` within `radius` metres (helper builds the QL).
// https://overpass-api.de/api/interpreter (keyless; be gentle — heavy queries).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "overpass_osm";
const TTL = 24 * 60 * 60 * 1000; // 24h

interface OverEl {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}
interface OverResp { elements?: OverEl[] }

export const execute: ToolExecute = async (params) => {
  const ql = String(params.ql ?? "").trim();
  const amenity = String(params.amenity ?? "").trim();
  const lat = params.lat, lon = params.lon;
  const radius = typeof params.radius === "number" ? Math.min(Math.max(50, params.radius), 10000) : 1000;
  let query: string;
  if (ql) {
    query = ql.includes("[out:json]") ? ql : `[out:json][timeout:25];${ql}`;
  } else if (amenity && typeof lat === "number" && typeof lon === "number") {
    query = `[out:json][timeout:25];(node["amenity"="${amenity}"](around:${radius},${lat},${lon}););out body 40;`;
  } else {
    return toolErr(ID, "provide a raw `ql` Overpass query, OR `amenity`+`lat`+`lon` (optional `radius` metres)");
  }
  const url = "https://overpass-api.de/api/interpreter";

  const r = await webFetchJson<OverResp>({ source: "overpass", op: "query", url, query: amenity || ql.slice(0, 60), ttlMs: TTL, method: "POST", body: `data=${encodeURIComponent(query)}`, headers: { "content-type": "application/x-www-form-urlencoded", accept: "*/*" }, userAgent: "ARGOS-Operator/2.4 (osm overpass tool)", timeoutMs: 30000 });
  if (!r.ok) return toolErr(ID, `Overpass request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const els = (r.data?.elements ?? []).slice(0, 40).map((e) => ({
    type: e.type ?? null,
    id: e.id ?? null,
    lat: e.lat ?? null,
    lon: e.lon ?? null,
    name: e.tags?.name ?? null,
    tags: e.tags ? Object.fromEntries(Object.entries(e.tags).slice(0, 8)) : null,
  }));
  if (els.length === 0) return toolErr(ID, "Overpass returned 0 matching features");
  return toolOk(ID, `Overpass: ${els.length} OSM feature(s)${amenity ? ` (amenity=${amenity})` : ""}`, {
    data: { query: amenity || "custom QL", count: els.length, elements: els, fromCache: r.fromCache },
  });
};
