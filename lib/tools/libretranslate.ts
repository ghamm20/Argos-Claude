// lib/tools/libretranslate.ts — T49 libretranslate (web, safe, local container)
//
// LibreTranslate — self-hosted machine translation. Default endpoint
// http://127.0.0.1:5000 (override LIBRETRANSLATE_URL). If the container is not
// running, the tool says SO — connection refused is surfaced honestly with the
// exact reason and how to start it; it NEVER fabricates a translation (the
// MiroFish v2.3.10 lesson: no fake "running" when a service is down).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "libretranslate";
const BASE = process.env.LIBRETRANSLATE_URL || "http://127.0.0.1:5000";

interface TransResp { translatedText?: string; detectedLanguage?: { language?: string; confidence?: number } }

export const execute: ToolExecute = async (params) => {
  const q = String(params.q ?? params.text ?? "").trim();
  if (!q) return toolErr(ID, "text (`q`) to translate is required");
  const source = String(params.source ?? "auto").trim();
  const target = String(params.target ?? "en").trim();
  const apiKey = String(params.apiKey ?? "").trim();
  const body = JSON.stringify({ q, source, target, format: "text", ...(apiKey ? { api_key: apiKey } : {}) });
  const url = `${BASE.replace(/\/$/, "")}/translate`;

  const r = await webFetchJson<TransResp>({ source: "libretranslate", op: "translate", url, query: `${source}->${target}`, ttlMs: 0, method: "POST", body, headers: { "content-type": "application/json" }, timeoutMs: 20000, maxRateWaitMs: 0 });
  if (!r.ok) {
    if (r.status === 0) {
      return toolErr(ID, `LibreTranslate not reachable at ${BASE} (connection refused${r.error ? `: ${r.error}` : ""}). Start the LibreTranslate container (default port 5000) to enable translation.`);
    }
    return toolErr(ID, `LibreTranslate returned HTTP ${r.status}${r.error ? `: ${r.error}` : ""}`);
  }
  const translated = r.data?.translatedText ?? "";
  if (!translated) return toolErr(ID, "LibreTranslate returned an empty translation");
  return toolOk(ID, `Translated (${r.data?.detectedLanguage?.language ?? source}→${target}): ${translated.slice(0, 120)}`, {
    data: { source, target, detected: r.data?.detectedLanguage ?? null, translatedText: translated, base: BASE },
  });
};
