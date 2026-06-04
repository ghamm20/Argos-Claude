// lib/tools/openfema.ts — T48 openfema (web, safe, keyless)
//
// OpenFEMA — disaster declarations + public assistance (api.fema.gov, OData).
// https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries (keyless).
// Default: Tennessee disaster declarations, newest first.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "openfema";
const TTL = 12 * 60 * 60 * 1000; // 12h

const DATASETS = new Set(["DisasterDeclarationsSummaries", "FemaWebDisasterDeclarations", "PublicAssistanceFundedProjectsDetails"]);

interface FemaResp { [k: string]: unknown }

export const execute: ToolExecute = async (params) => {
  const dataset = String(params.dataset ?? "DisasterDeclarationsSummaries").trim();
  if (!DATASETS.has(dataset)) return toolErr(ID, `unknown dataset "${dataset}" — use one of: ${[...DATASETS].join(", ")}`);
  const state = String(params.state ?? "TN").trim().toUpperCase();
  const top = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 50) : 10;
  const filter = /^[A-Z]{2}$/.test(state) ? `&$filter=state eq '${state}'` : "";
  const url = `https://www.fema.gov/api/open/v2/${encodeURIComponent(dataset)}?$top=${top}&$orderby=declarationDate desc${filter}`;

  const r = await webFetchJson<FemaResp>({ source: "fema", op: "open", url, query: `${dataset} ${state}`, ttlMs: TTL, timeoutMs: 25000 });
  if (!r.ok) return toolErr(ID, `OpenFEMA request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const rows = (r.data?.[dataset] as Array<Record<string, unknown>>) ?? [];
  if (rows.length === 0) return toolErr(ID, `OpenFEMA returned 0 ${dataset} rows for ${state}`);
  const trimmed = rows.slice(0, top).map((row) => {
    const out: Record<string, unknown> = {};
    for (const k of ["disasterNumber", "declarationDate", "declarationTitle", "incidentType", "state", "designatedArea"]) {
      if (k in row) out[k] = row[k];
    }
    return Object.keys(out).length ? out : Object.fromEntries(Object.entries(row).slice(0, 8));
  });
  return toolOk(ID, `OpenFEMA: ${rows.length} ${dataset} record(s) for ${state}`, {
    data: { dataset, state, count: rows.length, records: trimmed, fromCache: r.fromCache },
  });
};
