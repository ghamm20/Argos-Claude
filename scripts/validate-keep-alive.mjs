#!/usr/bin/env node
// validate-keep-alive.mjs — keep-alive coordination gate (2026-06-03).
//
// CONFIRMED ISSUE: the Bobby extractor (notmythos-8b) used to stay resident
// with a 2-minute keep-alive after every fact extraction, evicting Bart (8.1GB)
// on the 8GB card so Bart cold-loaded (~25s TTFT) on the next message.
//
// FIX: scope Ollama `keep_alive` per ROLE — conversational personas stay warm
// ("60m"), background/extractor calls release VRAM fast ("5s").
//
// This validates the fix at the Ollama layer via /api/ps (programmatic
// `ollama ps`), reading each loaded model's expires_at:
//   1. A conversational /api/chat to Bart → Bart resident with a LONG expiry
//      (~60min, definitely not the old 2-min default).
//   2. A background extraction (POST /api/memory/facts → Bobby) → Bobby has a
//      SHORT expiry (already released, or < ~60s) — it will NOT hold the slot.
//
// Requires the real models + GPU. Boots `next start` against a temp ARGOS_ROOT.
// Usage: node scripts/validate-keep-alive.mjs [--port 7869]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7869;
const ROOT = join(tmpdir(), `argos-keepalive-${process.pid}`);
const OLLAMA = process.env.OLLAMA_HOST?.replace(/^/, "") || "http://127.0.0.1:11434";
const OLLAMA_BASE = /^https?:/.test(OLLAMA) ? OLLAMA : `http://${OLLAMA}`;
const BART = "aratan/gemma-4-E4B-q8-it-heretic:latest";
const BOBBY = "CyberCrew/notmythos-8b:latest";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function reqJson(base, path, { method = "GET", body } = {}) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {}, timeout: 180000 },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => { try { res(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { res(null); } });
      }
    );
    r.on("error", () => res(null));
    r.on("timeout", () => { r.destroy(); res(null); });
    if (payload) r.write(payload);
    r.end();
  });
}

// Stream a chat turn to the ARGOS chat route (drains the NDJSON stream).
function chat(base, content, model) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }], personaId: "bartimaeus", model, useRetrieval: false, truthMode: false }));
    const url = new URL("/api/chat", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { "content-type": "application/json", "content-length": body.length }, timeout: 180000 }, (resp) => {
      let text = "", buf = "";
      resp.on("data", (c) => { buf += c.toString("utf8"); let nl; while ((nl = buf.indexOf("\n")) !== -1) { const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!ln) continue; try { const j = JSON.parse(ln); if (j?.message?.content) text += j.message.content; } catch { /* */ } } });
      resp.on("end", () => res(text.trim()));
    });
    r.on("error", () => res("[error]")); r.on("timeout", () => { r.destroy(); res("[timeout]"); });
    r.write(body); r.end();
  });
}

// /api/ps → [{ name, expiresInSec }]. expiresInSec computed against wall clock.
async function ps() {
  const j = await reqJson(OLLAMA_BASE, "/api/ps");
  const now = Date.now();
  return (j?.models ?? []).map((m) => ({
    name: m.name || m.model || "",
    expiresInSec: m.expires_at ? Math.round((Date.parse(m.expires_at) - now) / 1000) : null,
  }));
}
const find = (list, needle) => list.find((m) => m.name.includes(needle));
async function unload(model) { await reqJson(OLLAMA_BASE, "/api/generate", { method: "POST", body: { model, prompt: "", keep_alive: 0 } }); }
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await reqJson(base, "/api/runtime");
    if (r) return true; await new Promise((rs) => setTimeout(rs, 1000));
  } return false;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] validate-keep-alive (LIVE — Ollama /api/ps)\n");

  console.log("=== reset: unload Bart + Bobby (start clean) ===");
  await unload(BART); await unload(BOBBY);
  await new Promise((r) => setTimeout(r, 1500));
  const base0 = await ps();
  console.log(`  ollama ps: ${base0.map((m) => `${m.name}(${m.expiresInSec}s)`).join(", ") || "(empty)"}\n`);

  console.log("=== 1. CONVERSATIONAL — Bart should load with a LONG keep-alive (~60m) ===");
  const a = await chat(base, "Hello.", BART);
  console.log(`  Bart said: ${a.slice(0, 80)}${a.length > 80 ? "…" : ""}`);
  const afterChat = await ps();
  console.log(`  ollama ps: ${afterChat.map((m) => `${m.name}(${m.expiresInSec}s)`).join(", ") || "(empty)"}`);
  const bart = find(afterChat, "gemma-4-E4B");
  check("Bart resident after a message", !!bart, bart ? `expiresIn=${bart.expiresInSec}s` : "(not loaded)");
  check("Bart keep-alive is LONG (> 30 min, not 2-min default)", !!bart && bart.expiresInSec > 1800, bart ? `${bart.expiresInSec}s` : "");

  console.log("\n=== 2. BACKGROUND — Bobby extractor should load with a SHORT keep-alive (~5s) ===");
  const ex = await reqJson(base, "/api/memory/facts", { method: "POST", body: { userMessage: "My workstation is an RTX 3060 Ti with 8GB of VRAM.", assistantMessage: "Noted." } });
  console.log(`  extraction → ${ex ? JSON.stringify(ex).slice(0, 120) : "(no response)"}`);
  const afterExtract = await ps();
  console.log(`  ollama ps: ${afterExtract.map((m) => `${m.name}(${m.expiresInSec}s)`).join(", ") || "(empty)"}`);
  const bobby = find(afterExtract, "notmythos");
  // PASS if Bobby already released (absent) OR has a short expiry. FAIL on a long hold.
  check("Bobby keep-alive is SHORT (released or < 60s — never a 2-min hold)",
    !bobby || (bobby.expiresInSec !== null && bobby.expiresInSec < 60),
    bobby ? `expiresIn=${bobby.expiresInSec}s` : "(already released — ideal)");
  check("Bobby is NOT holding the slot for minutes",
    !bobby || bobby.expiresInSec < 120, bobby ? `${bobby.expiresInSec}s` : "(gone)");
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nvalidate-keep-alive: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
