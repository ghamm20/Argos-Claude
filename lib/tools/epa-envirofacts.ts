// lib/tools/epa-envirofacts.ts — T40 epa_envirofacts (web, safe, keyless)
//
// EPA Envirofacts REST service — environmental program facility data.
// https://data.epa.gov/efservice/<table>/<column>/<value>/JSON (keyless).
// Default: FRS program facilities in Tennessee.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "epa_envirofacts";
const TTL = 24 * 60 * 60 * 1000; // 24h

export const execute: ToolExecute = async (params) => {
  const table = String(params.table ?? "FRS_PROGRAM_FACILITY").trim();
  const column = String(params.column ?? "STATE_CODE").trim();
  const value = String(params.value ?? params.state ?? "TN").trim();
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 50) : 15;
  if (!/^[A-Za-z0-9_]+$/.test(table) || !/^[A-Za-z0-9_]+$/.test(column)) {
    return toolErr(ID, "table and column must be alphanumeric Envirofacts identifiers");
  }
  // efservice path API: /<table>/<column>/<value>/rows/0:<limit>/JSON
  const url = `https://data.epa.gov/efservice/${encodeURIComponent(table)}/${encodeURIComponent(column)}/${encodeURIComponent(value)}/rows/0:${limit}/JSON`;

  const r = await webFetchJson<unknown[]>({ source: "epa", op: "envirofacts", url, query: `${table}.${column}=${value}`, ttlMs: TTL, timeoutMs: 25000 });
  if (!r.ok) return toolErr(ID, `EPA Envirofacts request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const rows = Array.isArray(r.data) ? r.data : [];
  if (rows.length === 0) return toolErr(ID, `EPA Envirofacts returned 0 rows for ${table}.${column}=${value}`);
  // Keep the payload lean: first ~12 columns of up to `limit` rows.
  const trimmed = rows.slice(0, limit).map((row) => {
    const obj = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).slice(0, 12)) out[k] = obj[k];
    return out;
  });
  return toolOk(ID, `EPA Envirofacts: ${rows.length} row(s) from ${table} where ${column}=${value}`, {
    data: { table, filter: `${column}=${value}`, count: rows.length, rows: trimmed, fromCache: r.fromCache },
  });
};
