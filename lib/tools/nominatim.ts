// lib/tools/nominatim.ts — T41 nominatim (web, safe, keyless)
//
// OpenStreetMap Nominatim — forward geocoding (place name → lat/lon) and
// reverse (lat/lon → address). https://nominatim.openstreetmap.org (keyless;
// REQUIRES a descriptive User-Agent; max 1 req/s — honored by the rate limiter).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "nominatim";
const TTL = 7 * 24 * 60 * 60 * 1000; // 7d (geocoding is stable)
const UA = "ARGOS-Operator/2.4 (local geocoding tool)";

interface NomItem {
  display_name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
  importance?: number;
  address?: Record<string, string>;
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? params.q ?? "").trim();
  const lat = params.lat, lon = params.lon;
  const reverse = typeof lat === "number" && typeof lon === "number";
  let url: string;
  if (reverse) {
    url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1`;
  } else if (q) {
    const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 10) : 5;
    url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=${limit}`;
  } else {
    return toolErr(ID, "provide `query` (place name) for geocoding, or numeric `lat`+`lon` for reverse geocoding");
  }

  const r = await webFetchJson<NomItem | NomItem[]>({ source: "nominatim", op: reverse ? "reverse" : "search", url, query: q || `${lat},${lon}`, ttlMs: TTL, headers: { "user-agent": UA }, userAgent: UA, rate: { requestsPerMinute: 60, burst: 1 } });
  if (!r.ok) return toolErr(ID, `Nominatim request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const arr = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
  const places = arr.map((p) => ({
    name: p.display_name ?? null,
    lat: p.lat ? Number(p.lat) : null,
    lon: p.lon ? Number(p.lon) : null,
    type: p.type ?? null,
    class: p.class ?? null,
    address: p.address ?? null,
  }));
  if (places.length === 0) return toolErr(ID, `Nominatim found no match for "${q || `${lat},${lon}`}"`);
  return toolOk(ID, `Nominatim: ${places.length} ${reverse ? "address" : "place"}(s) for "${q || `${lat},${lon}`}"`, {
    data: { query: q || `${lat},${lon}`, reverse, places, fromCache: r.fromCache },
  });
};
