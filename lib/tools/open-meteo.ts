// lib/tools/open-meteo.ts — open_meteo_weather (web, safe, keyless)
//
// Open-Meteo forecast + geocoding. Replaces the old DDG "weather forecast X
// today" query-reshape hack — this returns STRUCTURED current conditions +
// daily forecast, not scraped snippets.
//
//   - "weather in <place>"  → geocode the place, then forecast its lat/lon
//   - {latitude, longitude} → forecast directly
//
// Keyless, no rate limit for reasonable use. Cache: geocoding 30d (places
// don't move), forecast 15min (current conditions stay fresh). Routes through
// lib/web (Rule-4 safe).

import { toolOk, toolErr, type ToolExecute, type ToolResult } from "./types";
import { webFetchJson } from "../web";

export const ID = "open_meteo_weather";
const GEO_TTL = 30 * 24 * 60 * 60 * 1000;
const FORECAST_TTL = 15 * 60 * 1000;

// WMO weather interpretation codes → plain text.
const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog",
  51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  56: "light freezing drizzle", 57: "dense freezing drizzle",
  61: "slight rain", 63: "moderate rain", 65: "heavy rain",
  66: "light freezing rain", 67: "heavy freezing rain",
  71: "slight snow", 73: "moderate snow", 75: "heavy snow", 77: "snow grains",
  80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  85: "slight snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm w/ slight hail", 99: "thunderstorm w/ heavy hail",
};
const codeText = (c: number | undefined): string =>
  c == null ? "unknown" : WMO[c] ?? `code ${c}`;

interface GeoResp {
  results?: Array<{ latitude: number; longitude: number; name: string; country?: string; admin1?: string; timezone?: string }>;
}
interface ForecastResp {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  current_weather?: { temperature?: number; windspeed?: number; winddirection?: number; weathercode?: number; time?: string };
  hourly?: { time?: string[]; temperature_2m?: number[]; precipitation?: number[]; weather_code?: number[] };
  daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; weather_code?: number[]; precipitation_sum?: number[] };
}

export interface ResolvedLocation { name: string; lat: number; lon: number; tz: string }

/** Geocode a place name → coordinates. Exported for reuse by other tools.
 *
 *  Open-Meteo's geocoder matches a city name, not "City, State". So we try the
 *  full string, then progressively drop trailing words (state/country
 *  qualifiers) — and when we drop some, we use them to DISAMBIGUATE among
 *  candidates (e.g. "Winter Springs Florida" → search "Winter Springs",
 *  prefer the result in Florida). */
export async function geocode(place: string): Promise<ResolvedLocation | null> {
  const cleaned = place.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const words = cleaned.split(" ");
  const tried = new Set<string>();
  for (let n = words.length; n >= 1; n--) {
    const city = words.slice(0, n).join(" ");
    const key = city.toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`;
    const r = await webFetchJson<GeoResp>({ source: "open_meteo", op: "geocode", url, query: city, ttlMs: GEO_TTL });
    const results = r.data?.results ?? [];
    if (results.length === 0) continue;
    let pick = results[0];
    const rest = words.slice(n).map((w) => w.toLowerCase());
    if (rest.length) {
      const better = results.find((g) => {
        const hay = `${g.admin1 ?? ""} ${g.country ?? ""}`.toLowerCase();
        return rest.some((w) => hay.includes(w));
      });
      if (better) pick = better;
    }
    return {
      name: [pick.name, pick.admin1, pick.country].filter(Boolean).join(", "),
      lat: pick.latitude,
      lon: pick.longitude,
      tz: pick.timezone ?? "auto",
    };
  }
  return null;
}

export interface WeatherData {
  location: { name: string; lat: number; lon: number; tz: string };
  current: { temp: number | null; unit: string; windspeed: number | null; code: number | null; text: string } | null;
  daily: Array<{ date: string; high: number | null; low: number | null; code: number | null; text: string; precip: number | null }>;
  hourly: Array<{ time: string; temp: number | null; precip: number | null; text: string }>;
  fromCache: boolean;
}

export const execute: ToolExecute = async (params) => {
  const location = String(params.location ?? "").trim();
  const latIn = typeof params.latitude === "number" ? params.latitude : null;
  const lonIn = typeof params.longitude === "number" ? params.longitude : null;
  const days = typeof params.forecast_days === "number" ? Math.min(Math.max(1, params.forecast_days), 16) : 7;

  let place: ResolvedLocation | null = null;
  if (latIn !== null && lonIn !== null) {
    place = { name: location || `${latIn.toFixed(3)}, ${lonIn.toFixed(3)}`, lat: latIn, lon: lonIn, tz: "auto" };
  } else if (location) {
    place = await geocode(location);
    if (!place) return toolErr(ID, `could not geocode "${location}"`);
  } else {
    return toolErr(ID, "location (place name) or latitude+longitude is required");
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current_weather=true&hourly=temperature_2m,precipitation,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum` +
    `&timezone=auto&forecast_days=${days}&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`;
  const r = await webFetchJson<ForecastResp>({ source: "open_meteo", op: "forecast", url, query: place.name, ttlMs: FORECAST_TTL });
  if (!r.ok || !r.data) return toolErr(ID, r.error ?? "Open-Meteo forecast failed");

  const f = r.data;
  const cw = f.current_weather;
  const daily = (f.daily?.time ?? []).slice(0, days).map((date, i) => ({
    date,
    high: f.daily?.temperature_2m_max?.[i] ?? null,
    low: f.daily?.temperature_2m_min?.[i] ?? null,
    code: f.daily?.weather_code?.[i] ?? null,
    text: codeText(f.daily?.weather_code?.[i]),
    precip: f.daily?.precipitation_sum?.[i] ?? null,
  }));
  const hourly = (f.hourly?.time ?? []).slice(0, 12).map((time, i) => ({
    time,
    temp: f.hourly?.temperature_2m?.[i] ?? null,
    precip: f.hourly?.precipitation?.[i] ?? null,
    text: codeText(f.hourly?.weather_code?.[i]),
  }));

  const data: WeatherData = {
    location: { name: place.name, lat: place.lat, lon: place.lon, tz: f.timezone ?? place.tz },
    current: cw
      ? { temp: cw.temperature ?? null, unit: "°F", windspeed: cw.windspeed ?? null, code: cw.weathercode ?? null, text: codeText(cw.weathercode) }
      : null,
    daily,
    hourly,
    fromCache: r.fromCache,
  };
  const summary = data.current
    ? `Weather for ${place.name}: ${data.current.temp}°F, ${data.current.text}, wind ${data.current.windspeed} mph`
    : `Forecast for ${place.name} (${daily.length} day${daily.length === 1 ? "" : "s"})`;
  return toolOk(ID, summary, { data, sources: ["https://open-meteo.com"] });
};

/** Format an open_meteo_weather result as an authoritative grounding block for
 *  Bart's system prompt (parallel to buildCurrentFactsBlock for web_search). */
export function buildWeatherBlock(result: ToolResult): string {
  const d = result.data as WeatherData | undefined;
  if (!d) return "";
  const lines: string[] = [
    "CURRENT WEATHER — FRESHLY RETRIEVED, AUTHORITATIVE (Open-Meteo).",
    "",
    `Location: ${d.location.name} (${d.location.lat.toFixed(2)}, ${d.location.lon.toFixed(2)}, tz ${d.location.tz})`,
  ];
  if (d.current) {
    lines.push(`Right now: ${d.current.temp}°F, ${d.current.text}, wind ${d.current.windspeed} mph.`);
  }
  if (d.daily.length) {
    lines.push("Forecast:");
    for (const day of d.daily.slice(0, 5)) {
      lines.push(`- ${day.date}: high ${day.high}°F / low ${day.low}°F, ${day.text}${day.precip != null ? `, precip ${day.precip} in` : ""}`);
    }
  }
  lines.push("", "Answer the operator's weather question from THIS data, in plain language. It is live and overrides training data. Give the current temperature/conditions first.");
  return lines.join("\n");
}
