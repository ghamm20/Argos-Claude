// lib/tools/hibp.ts — T50 hibp (web, safe, KEYED — graceful skip)
//
// Have I Been Pwned v3 — breaches for an account. Requires a paid API key
// (Settings → API keys → hibp). No key → honest "not configured" (never faked).
// https://haveibeenpwned.com/api/v3/breachedaccount/<account>

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson, getApiKey } from "../web";

export const ID = "hibp";
const TTL = 60 * 60 * 1000; // 1h

interface Breach { Name?: string; Title?: string; BreachDate?: string; PwnCount?: number; DataClasses?: string[] }

export const execute: ToolExecute = async (params) => {
  const account = String(params.account ?? params.email ?? "").trim();
  if (!account) return toolErr(ID, "account (email/username) is required");
  const key = await getApiKey("hibp");
  if (!key) {
    return toolOk(ID, "Have I Been Pwned is not configured — add an HIBP API key in Settings → API keys to enable breach lookups.", { data: { configured: false, account } });
  }
  const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(account)}?truncateResponse=false`;
  const r = await webFetchJson<Breach[]>({ source: "hibp", op: "breaches", url, query: account, ttlMs: TTL, headers: { "hibp-api-key": key, "user-agent": "ARGOS-Operator" }, timeoutMs: 20000 });
  // 404 = the account appears in NO breaches — good news, surfaced honestly.
  if (!r.ok && r.status === 404) {
    return toolOk(ID, `Have I Been Pwned: NO breaches found for ${account} (clean).`, { data: { configured: true, account, breachCount: 0, breaches: [] } });
  }
  if (!r.ok) {
    if (r.status === 401) return toolErr(ID, "HIBP rejected the API key (401) — check the key in Settings.");
    return toolErr(ID, `HIBP request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  }
  const breaches = (r.data ?? []).map((b) => ({ name: b.Title ?? b.Name ?? null, date: b.BreachDate ?? null, pwnCount: b.PwnCount ?? null, dataClasses: b.DataClasses ?? [] }));
  return toolOk(ID, `Have I Been Pwned: ${breaches.length} breach(es) for ${account}`, { data: { configured: true, account, breachCount: breaches.length, breaches } });
};
