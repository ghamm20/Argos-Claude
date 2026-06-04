// lib/tools/nhtsa.ts — T47 nhtsa (web, safe, keyless)
//
// NHTSA — vehicle safety recalls (api.nhtsa.gov) + VIN decode (vpic).
//   recalls: make+model+modelYear   |   vin: decode a 17-char VIN
// Keyless.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "nhtsa";
const TTL = 24 * 60 * 60 * 1000; // 24h

interface RecallResp { Count?: number; results?: Array<{ NHTSACampaignNumber?: string; Component?: string; Summary?: string; Remedy?: string; ReportReceivedDate?: string }> }
interface VinResp { Results?: Array<{ Variable?: string; Value?: string | null }> }

export const execute: ToolExecute = async (params) => {
  const vin = String(params.vin ?? "").trim();
  if (vin) {
    if (!/^[A-HJ-NPR-Z0-9]{11,17}$/i.test(vin)) return toolErr(ID, "vin must be 11–17 alphanumeric characters (no I/O/Q)");
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${encodeURIComponent(vin)}?format=json`;
    const r = await webFetchJson<VinResp>({ source: "nhtsa", op: "vin", url, query: vin, ttlMs: TTL, timeoutMs: 20000 });
    if (!r.ok) return toolErr(ID, `NHTSA VIN decode failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
    const fields = (r.data?.Results ?? []).filter((f) => f.Value && f.Value !== "Not Applicable").map((f) => ({ field: f.Variable, value: f.Value }));
    const pick = (n: string) => fields.find((f) => f.field === n)?.value ?? null;
    return toolOk(ID, `NHTSA VIN ${vin}: ${[pick("Model Year"), pick("Make"), pick("Model")].filter(Boolean).join(" ") || "decoded"}`, {
      data: { vin, summary: { year: pick("Model Year"), make: pick("Make"), model: pick("Model"), bodyClass: pick("Body Class"), plant: pick("Plant Country") }, fields: fields.slice(0, 40), fromCache: r.fromCache },
    });
  }
  const make = String(params.make ?? "").trim();
  const model = String(params.model ?? "").trim();
  const year = String(params.modelYear ?? params.year ?? "").trim();
  if (!make || !model || !/^\d{4}$/.test(year)) return toolErr(ID, "provide `vin`, OR `make`+`model`+`modelYear` (4-digit year) for recalls");
  const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
  const r = await webFetchJson<RecallResp>({ source: "nhtsa", op: "recalls", url, query: `${year} ${make} ${model}`, ttlMs: TTL, timeoutMs: 20000 });
  if (!r.ok) return toolErr(ID, `NHTSA recalls request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const recalls = (r.data?.results ?? []).map((x) => ({ campaign: x.NHTSACampaignNumber ?? null, component: x.Component ?? null, summary: x.Summary?.slice(0, 300) ?? null, remedy: x.Remedy?.slice(0, 200) ?? null, date: x.ReportReceivedDate ?? null }));
  // 0 recalls is GOOD news — surface it honestly, not as an error.
  return toolOk(ID, recalls.length ? `NHTSA: ${recalls.length} recall(s) for ${year} ${make} ${model}` : `NHTSA: NO recalls on record for ${year} ${make} ${model}`, {
    data: { vehicle: `${year} ${make} ${model}`, count: recalls.length, recalls, fromCache: r.fromCache },
  });
};
