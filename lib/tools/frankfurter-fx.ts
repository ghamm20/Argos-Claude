// lib/tools/frankfurter-fx.ts — T46 frankfurter_fx (web, safe, keyless)
//
// Frankfurter — ECB reference foreign-exchange rates + conversion.
// https://api.frankfurter.app/latest (keyless).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "frankfurter_fx";
const TTL = 60 * 60 * 1000; // 1h (ECB updates ~daily)

interface FxResp { amount?: number; base?: string; date?: string; rates?: Record<string, number> }

export const execute: ToolExecute = async (params) => {
  const from = String(params.from ?? params.base ?? "USD").trim().toUpperCase();
  const to = String(params.to ?? params.symbols ?? "EUR").trim().toUpperCase();
  const amount = typeof params.amount === "number" && params.amount > 0 ? params.amount : 1;
  if (!/^[A-Z]{3}(,[A-Z]{3})*$/.test(from) || !/^[A-Z]{3}(,[A-Z]{3})*$/.test(to)) {
    return toolErr(ID, "from/to must be 3-letter currency codes (e.g. USD, EUR)");
  }
  const url = `https://api.frankfurter.app/latest?amount=${amount}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const r = await webFetchJson<FxResp>({ source: "frankfurter", op: "fx", url, query: `${amount} ${from}->${to}`, ttlMs: TTL, timeoutMs: 15000 });
  if (!r.ok) return toolErr(ID, `Frankfurter request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const rates = r.data?.rates ?? {};
  if (Object.keys(rates).length === 0) return toolErr(ID, `Frankfurter returned no rates for ${from}->${to} (check the currency codes)`);
  const lines = Object.entries(rates).map(([cur, v]) => `${amount} ${from} = ${v} ${cur}`);
  return toolOk(ID, `Frankfurter (ECB, ${r.data?.date ?? "latest"}): ${lines.join("; ")}`, {
    data: { amount, from, date: r.data?.date ?? null, rates, fromCache: r.fromCache },
  });
};
