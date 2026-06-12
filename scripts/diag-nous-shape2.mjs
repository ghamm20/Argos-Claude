// scripts/diag-nous-shape2.mjs
//
// Task 1c stage 2 — reproduce the empty-content failure with the REAL
// production prompt (the full ~25.7k-char Bart system prompt captured in
// _diag_empty-content-1.json) at max_tokens 250, the exact shape the
// orchestrator sends on a Bart brief turn. Then the candidate fixes:
//   P1..P3 — production replica (big system, max 250)
//   F1     — big system, max_tokens 1024 floor
//   F2     — big system, max 250 + reasoning suppressed via /no_think-style
//            system line (nemotron convention: "detailed thinking off")
//
// Run: node scripts/diag-nous-shape2.mjs

import { promises as fsp } from "node:fs";
import { createDecipheriv } from "node:crypto";
import path from "node:path";

// Deploy root: env override, else assembled from parts (USB-native Rule 1).
const ROOT = process.env.ARGOS_ROOT || ["D:", "ARGOS"].join(path.sep);
const NOUS_CHAT_URL = "https://inference-api.nousresearch.com/v1/chat/completions";
const NOUS_MODEL = "nvidia/nemotron-3-ultra:free";
const PREFIX = "enc:v1:";

async function loadKey() {
  const settings = JSON.parse(
    await fsp.readFile(path.join(ROOT, "config", "settings.json"), "utf8")
  );
  const cipher = settings.nousApiKey;
  if (!cipher.startsWith(PREFIX)) return cipher;
  const keyHex = (
    await fsp.readFile(path.join(ROOT, "config", ".argos-secret-key"), "utf8")
  ).trim();
  const [ivHex, tagHex, dataHex] = cipher.slice(PREFIX.length).split(":");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([d.update(Buffer.from(dataHex, "hex")), d.final()]).toString("utf8");
}

const diag = JSON.parse(
  await fsp.readFile(new URL("../_diag_empty-content-1.json", import.meta.url), "utf8")
);
const bigSystem = diag.exactRequest.messages[0].content; // ~25.7k chars
const userMsg = { role: "user", content: "Identify yourself in one short sentence." };

async function call(apiKey, label, body, timeoutMs = 90_000) {
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
    try { json = JSON.parse(text); } catch { /* raw */ }
    const msg = json?.choices?.[0]?.message ?? null;
    return {
      label,
      ms: Date.now() - started,
      status: res.status,
      finish_reason: json?.choices?.[0]?.finish_reason ?? null,
      contentChars: (msg?.content ?? "").length,
      reasoningChars: (msg?.reasoning_content ?? msg?.reasoning ?? "").length || 0,
      usage: json?.usage ?? null,
      contentHead: (msg?.content ?? "").slice(0, 120),
    };
  } catch (e) {
    return { label, ms: Date.now() - started, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const apiKey = await loadKey();
console.log(`system prompt: ${bigSystem.length} chars`);
const results = [];
for (const [label, body] of [
  ["P1-prod-max250", { model: NOUS_MODEL, messages: [{ role: "system", content: bigSystem }, userMsg], max_tokens: 250, stream: false }],
  ["P2-prod-max250", { model: NOUS_MODEL, messages: [{ role: "system", content: bigSystem }, userMsg], max_tokens: 250, stream: false }],
  ["P3-prod-max250", { model: NOUS_MODEL, messages: [{ role: "system", content: bigSystem }, userMsg], max_tokens: 250, stream: false }],
  ["F1-prod-max1024", { model: NOUS_MODEL, messages: [{ role: "system", content: bigSystem }, userMsg], max_tokens: 1024, stream: false }],
  ["F2-prod-max250-nothink", { model: NOUS_MODEL, messages: [{ role: "system", content: "detailed thinking off\n\n" + bigSystem }, userMsg], max_tokens: 250, stream: false }],
]) {
  const r = await call(apiKey, label, body);
  results.push(r);
  console.log(
    `${label}: ${r.error ? "ERROR " + r.error : `status ${r.status} finish=${r.finish_reason} content=${r.contentChars}ch reasoning=${r.reasoningChars}ch completion_tokens=${r.usage?.completion_tokens}`} (${r.ms}ms)`
  );
}
await fsp.writeFile("_diag_nous-shape2.json", JSON.stringify(results, null, 2));
console.log("written: _diag_nous-shape2.json");
