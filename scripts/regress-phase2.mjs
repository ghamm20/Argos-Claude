#!/usr/bin/env node
// regress-phase2.mjs — Phase 2 regression harness (2026-06-10).
//
// Gate 1 evidence: "identical persona responses pre/post on a fixed prompt
// set (diff shown)". LLM sampling is nondeterministic, so raw live replies
// can't be diffed — instead this harness makes the WHOLE pipeline
// deterministic with a MOCK Ollama (OLLAMA_HOST env points the real
// `next start` at this process) and captures, per case:
//
//   - the EXACT request body /api/chat sent upstream (full system prompt,
//     message list, options, think, model, keep_alive — the entire prompt
//     pipeline output), and
//   - the EXACT byte stream the client received (every NDJSON frame:
//     routing/vision/memory/backend events, model frames, retrieval/research
//     tails).
//
// Same canned model output in → byte-identical capture out, unless the
// refactor changed behavior. Run pre-refactor and post-refactor, then diff.
//
// Fixed prompt set: all 4 personas (operator), guest mode, /deep mode,
// multi-turn (conversation-reminder part), retrieval-enabled. Prompts avoid
// current-facts / research / explicit-tool phrasing so no network tools fire.
//
// Usage: node scripts/regress-phase2.mjs --out argos-phase2-regress-pre.json

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : "argos-phase2-regress.json";
const PORT = 7916;
const MOCK_PORT = 11438;
const BASE = `http://127.0.0.1:${PORT}`;
// FIXED root (not pid-keyed): the fixture path appears nowhere in prompts,
// but keep it identical across pre/post runs anyway.
const ROOT = join(tmpdir(), "argos-phase2-regress-root");

const MODEL_BART = "aratan/gemma-4-E4B-q8-it-heretic:latest";
const MODEL_JUNIPER = "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b";
const MODEL_BOBBY = "CyberCrew/notmythos-8b:latest";

// ---- mock Ollama ----
// Deterministic canned NDJSON for /api/chat; "[]" for extractor-style
// prompts so no memory facts are ever stored (keeps later cases' recall
// empty and deterministic). /api/show reports a declared num_ctx so
// resolveNumCtx adds nothing. /api/tags lists the bound models.
const exchanges = []; // { path, body }
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    exchanges.push({ path: req.url, body: bodyText });
    if (req.url === "/api/chat") {
      let j = null;
      try { j = JSON.parse(bodyText); } catch { /* */ }
      const sys = j?.messages?.[0]?.content ?? "";
      const isExtractor = /fact-extraction tool|Output ONLY a JSON array/i.test(sys);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      if (isExtractor) {
        res.write(JSON.stringify({ message: { role: "assistant", content: "[]" }, done: false }) + "\n");
      } else {
        res.write(JSON.stringify({ message: { role: "assistant", content: "Deterministic canned reply for the Phase 2 regression. " }, done: false }) + "\n");
        res.write(JSON.stringify({ message: { role: "assistant", content: "No tools were used." }, done: false }) + "\n");
      }
      res.end(JSON.stringify({ done: true, done_reason: "stop", model: j?.model ?? "mock", prompt_eval_count: 345, eval_count: 12 }) + "\n");
    } else if (req.url === "/api/show") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ parameters: "num_ctx                        131072" }));
    } else if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [MODEL_BART, MODEL_JUNIPER, MODEL_BOBBY, "hermes3:8b", "nomic-embed-text:latest"].map((n) => ({ name: n, model: n })) }));
    } else if (req.url === "/api/embeddings" || req.url === "/api/embed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embedding: Array(768).fill(0.1), embeddings: [Array(768).fill(0.1)] }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }
  });
});

// ---- helpers ----
function req(path, { method = "POST", body = null, headers = {} } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ }
          res({ status: resp.statusCode, json: j, text }); }); });
    r.on("error", () => res({ status: 0, json: null, text: "" }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null, text: "" }); });
    if (payload) r.write(payload); r.end();
  });
}
function chatRaw(payload, token) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify(payload));
    const u = new URL("/api/chat", BASE);
    const headers = { "content-type": "application/json", "content-length": body.length };
    if (token) headers["authorization"] = `Bearer ${token}`;
    let raw = "";
    let status = 0;
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers, timeout: 120000 },
      (resp) => { status = resp.statusCode ?? 0;
        resp.on("data", (c) => { raw += c.toString("utf8"); });
        resp.on("end", () => res({ status, raw })); });
    r.on("error", () => res({ status, raw }));
    r.write(body); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- fixed prompt set ----
const CASES = [
  { name: "bart-operator", token: true, payload: { personaId: "bartimaeus", model: MODEL_BART, useRetrieval: false, messages: [{ role: "user", content: "[CASE 1] Describe your purpose in one sentence." }] } },
  { name: "juniper-operator", token: true, payload: { personaId: "juniper", model: MODEL_JUNIPER, useRetrieval: false, messages: [{ role: "user", content: "[CASE 2] Offer a brief greeting." }] } },
  { name: "sage-operator", token: true, payload: { personaId: "sage", model: MODEL_BART, useRetrieval: false, messages: [{ role: "user", content: "[CASE 3] Comment on the value of patience." }] } },
  { name: "bobby-operator", token: true, payload: { personaId: "bobby", model: MODEL_BOBBY, useRetrieval: false, messages: [{ role: "user", content: "[CASE 4] State your role in one sentence." }] } },
  { name: "bart-guest", token: false, payload: { personaId: "bartimaeus", model: MODEL_BART, useRetrieval: false, messages: [{ role: "user", content: "[CASE 5] Who are you?" }] } },
  { name: "bart-deep", token: true, payload: { personaId: "bartimaeus", model: MODEL_BART, useRetrieval: false, messages: [{ role: "user", content: "/deep [CASE 6] Reflect on the nature of long service." }] } },
  { name: "bart-multiturn", token: true, payload: { personaId: "bartimaeus", model: MODEL_BART, useRetrieval: false, messages: [
    { role: "user", content: "[CASE 7a] Name a virtue." },
    { role: "assistant", content: "Patience, obviously." },
    { role: "user", content: "[CASE 7b] And why that one?" },
  ] } },
  { name: "bart-retrieval-truth", token: true, payload: { personaId: "bartimaeus", model: MODEL_BART, useRetrieval: true, truthMode: true, messages: [{ role: "user", content: "[CASE 8] Summarize the standing doctrine." }] } },
];

// ---- run ----
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
await new Promise((res) => mock.listen(MOCK_PORT, "127.0.0.1", res));
console.log(`[mock] deterministic Ollama on :${MOCK_PORT}`);

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT, OLLAMA_HOST: `127.0.0.1:${MOCK_PORT}` }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

const results = [];
try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  const s = await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  if (s.status !== 200) throw new Error(`settings setup failed (${s.status})`);
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const token = v.json?.token;
  if (!token) throw new Error("no session token");
  console.log(`[ready] running ${CASES.length} fixed cases\n`);

  for (const c of CASES) {
    const before = exchanges.length;
    const r = await chatRaw(c.payload, c.token ? token : null);
    // Primary upstream exchange = the /api/chat call whose LAST user message
    // matches this case's marker. (Extractor calls quote the text inside a
    // different envelope; matching on the exact last-user content is unique.)
    const marker = c.payload.messages[c.payload.messages.length - 1].content;
    const primary = exchanges.slice(before).map((e) => {
      if (e.path !== "/api/chat") return null;
      try { return JSON.parse(e.body); } catch { return null; }
    }).find((j) => {
      const msgs = j?.messages;
      if (!Array.isArray(msgs)) return false;
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      // /deep is stripped server-side before the model sees it.
      const expected = marker.replace(/^\s*\/deep\b[ \t]*/i, "");
      return lastUser?.content === expected;
    }) ?? null;
    // Wait for the fire-and-forget extractor calls to land before the next
    // case so exchange attribution can't bleed across cases.
    await new Promise((rs) => setTimeout(rs, 1500));
    results.push({
      name: c.name,
      status: r.status,
      upstreamRequest: primary,
      upstreamRequestSha256: primary ? sha(JSON.stringify(primary)) : null,
      clientStream: r.raw,
      clientStreamSha256: sha(r.raw),
    });
    console.log(`  ${c.name.padEnd(22)} status=${r.status}  upstream=${primary ? "captured" : "MISSING"}  req-sha=${(primary ? sha(JSON.stringify(primary)) : "n/a").slice(0, 12)}  stream-sha=${sha(r.raw).slice(0, 12)}`);
  }
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  mock.close();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

fs.writeFileSync(join(repoRoot, OUT), JSON.stringify({ cases: results }, null, 2), "utf8");
console.log(`\nregress-phase2: ${results.length} cases captured → ${OUT}`);
