// lib/tools/congress-gov.ts — T51 congress_gov (web, safe, KEYED — graceful skip)
//
// api.congress.gov v3 — recent bills + bill lookup. Free key via api.data.gov
// (Settings → API keys → congress_gov). No key → honest "not configured".

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson, getApiKey } from "../web";

export const ID = "congress_gov";
const TTL = 3 * 60 * 60 * 1000; // 3h

interface Bill { congress?: number; type?: string; number?: string; title?: string; latestAction?: { actionDate?: string; text?: string }; updateDate?: string; url?: string }
interface BillsResp { bills?: Bill[] }

export const execute: ToolExecute = async (params) => {
  const key = await getApiKey("congress_gov");
  if (!key) {
    return toolOk(ID, "congress.gov is not configured — add a Congress API key (free at api.data.gov) in Settings → API keys.", { data: { configured: false } });
  }
  const congress = String(params.congress ?? "").trim();
  const billType = String(params.billType ?? "").trim().toLowerCase();
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 20) : 10;
  let path = "bill";
  if (/^\d+$/.test(congress)) path += `/${congress}`;
  if (path.includes("/") && /^(hr|s|hjres|sjres|hconres|sconres|hres|sres)$/.test(billType)) path += `/${billType}`;
  const url = `https://api.congress.gov/v3/${path}?api_key=${encodeURIComponent(key)}&limit=${limit}&sort=updateDate+desc&format=json`;

  const r = await webFetchJson<BillsResp>({ source: "congress", op: "bills", url, query: path, ttlMs: TTL, timeoutMs: 20000 });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return toolErr(ID, `congress.gov rejected the API key (HTTP ${r.status}) — check the key in Settings.`);
    return toolErr(ID, `congress.gov request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  }
  const bills = (r.data?.bills ?? []).map((b) => ({
    id: b.type && b.number ? `${b.type}${b.number} (${b.congress}th)` : null,
    title: b.title ?? null,
    latestAction: b.latestAction?.text ?? null,
    actionDate: b.latestAction?.actionDate ?? null,
    updateDate: b.updateDate ?? null,
  }));
  if (bills.length === 0) return toolErr(ID, "congress.gov returned 0 bills for that query");
  return toolOk(ID, `congress.gov: ${bills.length} bill(s)${congress ? ` (${congress}th Congress)` : " (recent)"}`, { data: { configured: true, count: bills.length, bills, fromCache: r.fromCache } });
};
