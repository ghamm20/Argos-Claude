#!/usr/bin/env node
// diag-empty-content.mjs — Phase 1.5 Condition 2 root-cause harness (2026-06-10).
//
// Reproduces auth-smoke step 4 ("operator chat non-empty content", the chronic
// "operator-chat-1-char" flake) N times against a REAL `next start`, with
// OLLAMA_HOST pointed at a local TEE PROXY (this process) that forwards to the
// real daemon and records, per exchange:
//   - the EXACT request body the chat route sent (full prompt, options, think)
//   - the RAW NDJSON stream Ollama returned (content/thinking frames + the
//     final done frame: done_reason, eval_count, prompt_eval_count)
//
// Zero production-code changes: getOllamaBase() honors OLLAMA_HOST.
//
// On any trial with accumulated client-visible content <= 20 chars (the
// auth-smoke failure threshold), the full exchange is dumped verbatim to
// _diag_empty-content-<trial>.json (gitignored) and a classification line is
// printed: thinking-channel / stop-token / length-cap / model-defect.
//
// Usage: node scripts/diag-empty-content.mjs [--trials 15] [--port 7914]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : dflt;
};
const TRIALS = argOf("--trials", 15);
const PORT = argOf("--port", 7914);
const PROXY_PORT = argOf("--proxy-port", 11436);
const REAL_OLLAMA = "http://127.0.0.1:11434";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-diag-empty-${process.pid}`);
const MODEL = "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b";

// ---- tee proxy: forwards to the real daemon, records every exchange ----
const exchanges = []; // { path, requestBody, rawResponse, status }
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const requestBody = Buffer.concat(chunks).toString("utf8");
    const rec = { path: req.url, requestBody, rawResponse: "", status: 0 };
    exchanges.push(rec);
    try {
      const upstream = await fetch(`${REAL_OLLAMA}${req.url}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: ["POST", "PUT"].includes(req.method) ? requestBody : undefined,
      });
      rec.status = upstream.status;
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/x-ndjson" });
      if (!upstream.body) { res.end(); return; }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rec.rawResponse += Buffer.from(value).toString("utf8");
        res.write(value);
      }
      res.end();
    } catch (e) {
      rec.rawResponse = `PROXY ERROR: ${e.message}`;
      try { res.writeHead(502); res.end(); } catch { /* */ }
    }
  });
});

function req(path, { method = "POST", body = null, headers = {} } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 180000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ }
          res({ status: resp.statusCode, json: j, text }); }); });
    r.on("error", () => res({ status: 0, json: null, text: "" }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null, text: "" }); });
    if (payload) r.write(payload); r.end();
  });
}
// auth-smoke step-4 replica: stream /api/chat, accumulate message.content.
function chat(token) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({
      messages: [{ role: "user", content: "Identify yourself in one short sentence." }],
      personaId: "bartimaeus",
      model: MODEL,
      useRetrieval: false,
    }));
    const u = new URL("/api/chat", BASE);
    let content = "", status = 0;
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": body.length }, timeout: 180000 },
      (resp) => {
        status = resp.statusCode ?? 0;
        let buf = "";
        resp.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (line) { try { const j = JSON.parse(line); if (j.message?.content) content += j.message.content; } catch { /* */ } }
            nl = buf.indexOf("\n");
          }
        });
        resp.on("end", () => res({ status, content }));
      });
    r.on("error", () => res({ status, content }));
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

// Classify a captured Ollama exchange for an empty/short-content trial.
function classify(rec) {
  const frames = rec.rawResponse.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const contentChars = frames.reduce((n, f) => n + (f.message?.content?.length ?? 0), 0);
  const thinkingChars = frames.reduce((n, f) => n + (f.message?.thinking?.length ?? 0), 0);
  const done = frames.find((f) => f.done === true) ?? {};
  const reqJson = (() => { try { return JSON.parse(rec.requestBody); } catch { return null; } })();
  const promptChars = JSON.stringify(reqJson?.messages ?? "").length;
  let verdict = "model-defect (no clear channel/stop/length signature)";
  if (thinkingChars > 0 && contentChars <= 20) verdict = "thinking-channel: output went to message.thinking, not message.content";
  else if (done.done_reason === "length" && contentChars <= 20) verdict = "length-cap: num_predict exhausted before visible content";
  else if (done.done_reason === "stop" && (done.eval_count ?? 0) <= 3) verdict = "stop-token: model emitted a stop sequence immediately";
  return { contentChars, thinkingChars, done_reason: done.done_reason ?? null, eval_count: done.eval_count ?? null, prompt_eval_count: done.prompt_eval_count ?? null, promptChars, think: reqJson?.think ?? null, num_predict: reqJson?.options?.num_predict ?? null, verdict };
}

// ---- run ----
fs.mkdirSync(ROOT, { recursive: true });
await new Promise((res) => proxy.listen(PROXY_PORT, "127.0.0.1", res));
console.log(`[proxy] tee on :${PROXY_PORT} → ${REAL_OLLAMA}`);

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT, OLLAMA_HOST: `127.0.0.1:${PROXY_PORT}` }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

let failures = 0;
try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const token = v.json?.token;
  if (!token) throw new Error(`no session token (verify status ${v.status})`);
  console.log(`[ready] ${TRIALS} trials — auth-smoke step-4 replica (persona=bartimaeus model=${MODEL})\n`);

  for (let t = 1; t <= TRIALS; t++) {
    const before = exchanges.length;
    const c = await chat(token);
    const rec = exchanges.slice(before).find((e) => e.path === "/api/chat");
    const cls = rec ? classify(rec) : null;
    const failed = c.content.length <= 20;
    if (failed) failures++;
    console.log(`trial ${String(t).padStart(2)}: status=${c.status} client-content=${String(c.content.length).padStart(4)} chars` +
      (cls ? `  | ollama: content=${cls.contentChars} thinking=${cls.thinkingChars} done_reason=${cls.done_reason} eval=${cls.eval_count} prompt_eval=${cls.prompt_eval_count} think=${cls.think} num_predict=${cls.num_predict}` : "  | (no ollama exchange captured)") +
      (failed ? "   << FAILING RUN" : ""));
    if (failed && rec) {
      const dump = join(repoRoot, `_diag_empty-content-${t}.json`);
      fs.writeFileSync(dump, JSON.stringify({ trial: t, clientContent: c.content, classification: cls, exactRequest: JSON.parse(rec.requestBody), rawResponse: rec.rawResponse }, null, 2), "utf8");
      console.log(`  classification: ${cls.verdict}`);
      console.log(`  exact prompt + raw output dumped: ${dump}`);
    }
  }
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  proxy.close();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\ndiag-empty-content: ${failures}/${TRIALS} trials failed the >20-char threshold`);
process.exit(0);
