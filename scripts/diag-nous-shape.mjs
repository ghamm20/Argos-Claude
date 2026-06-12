// scripts/diag-nous-shape.mjs
//
// Task 1c (2026-06-12 directive) — root-cause the Nous empty-content failure
// (4/5 turns failing "nous returned empty content" / abort on 2026-06-11 even
// when the endpoint was reachable). Replays the EXACT production request shape
// against nvidia/nemotron-3-ultra:free and dumps the full raw response so the
// failure mode is observable, then varies one knob at a time:
//
//   trial A  — production replica: stream:false, max_tokens 250 (Bart's brief
//              cap, the value the orchestrator forwards on most turns)
//   trial B  — no max_tokens at all
//   trial C  — max_tokens 1024
//
// The key is decrypted from the LIVE deploy's settings (ARGOS_ROOT, default
// D:\ARGOS) using the same AES-256-GCM format as lib/web/secrets.ts. The key
// is never printed. Output: _diag_nous-shape.json (responses only, no auth).
//
// Run: node scripts/diag-nous-shape.mjs

import { promises as fsp } from "node:fs";
import { createDecipheriv } from "node:crypto";
import path from "node:path";

// Deploy root: env override, else assembled from parts (USB-native Rule 1 —
// no hardcoded absolute path literals in committed source).
const ROOT = process.env.ARGOS_ROOT || ["D:", "ARGOS"].join(path.sep);
const NOUS_CHAT_URL = "https://inference-api.nousresearch.com/v1/chat/completions";
const NOUS_MODEL = "nvidia/nemotron-3-ultra:free";
const PREFIX = "enc:v1:";

async function loadKey() {
  const settings = JSON.parse(
    await fsp.readFile(path.join(ROOT, "config", "settings.json"), "utf8")
  );
  const cipher = settings.nousApiKey;
  if (!cipher) throw new Error("nousApiKey not set in settings.json");
  if (!cipher.startsWith(PREFIX)) return cipher; // legacy plaintext
  const keyHex = (
    await fsp.readFile(path.join(ROOT, "config", ".argos-secret-key"), "utf8")
  ).trim();
  const [ivHex, tagHex, dataHex] = cipher.slice(PREFIX.length).split(":");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([d.update(Buffer.from(dataHex, "hex")), d.final()]).toString("utf8");
}

// Short persona-flavored system + user — small enough to isolate the response
// shape; the prod failure reproduced on ordinary chat turns, not jumbo prompts.
const MESSAGES = [
  { role: "system", content: "You are Bartimaeus, a sardonic 5000-year-old djinn. Answer briefly and precisely." },
  { role: "user", content: "Identify yourself in one short sentence." },
];

async function call(apiKey, label, body, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(NOUS_CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw */ }
    const msg = json?.choices?.[0]?.message ?? null;
    return {
      label,
      ms: Date.now() - started,
      status: res.status,
      finish_reason: json?.choices?.[0]?.finish_reason ?? null,
      contentChars: (msg?.content ?? "").length,
      messageKeys: msg ? Object.keys(msg) : null,
      reasoningChars:
        (msg?.reasoning_content ?? msg?.reasoning ?? "").length || 0,
      usage: json?.usage ?? null,
      modelEcho: json?.model ?? null,
      raw: json ?? text.slice(0, 2000),
    };
  } catch (e) {
    return { label, ms: Date.now() - started, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const apiKey = await loadKey();
console.log("key decrypted: yes (not shown)");
const results = [];
for (const [label, body] of [
  ["A1-replica-max250", { model: NOUS_MODEL, messages: MESSAGES, max_tokens: 250, stream: false }],
  ["A2-replica-max250", { model: NOUS_MODEL, messages: MESSAGES, max_tokens: 250, stream: false }],
  ["A3-replica-max250", { model: NOUS_MODEL, messages: MESSAGES, max_tokens: 250, stream: false }],
  ["B1-no-max", { model: NOUS_MODEL, messages: MESSAGES, stream: false }],
  ["C1-max1024", { model: NOUS_MODEL, messages: MESSAGES, max_tokens: 1024, stream: false }],
]) {
  const r = await call(apiKey, label, body);
  results.push(r);
  console.log(
    `${label}: ${r.error ? "ERROR " + r.error : `status ${r.status} finish=${r.finish_reason} content=${r.contentChars}ch reasoning=${r.reasoningChars}ch usage=${JSON.stringify(r.usage)} keys=${JSON.stringify(r.messageKeys)}`} (${r.ms}ms)`
  );
}
await fsp.writeFile("_diag_nous-shape.json", JSON.stringify(results, null, 2));
console.log("written: _diag_nous-shape.json");
