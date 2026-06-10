#!/usr/bin/env node
// proof-phase3-gate5.mjs — Phase 3 Gate 5 proof (2026-06-10).
//
// The uncited-claim guard must catch the Phase 2 live-proof fabrication: zero
// retrieval hits, truth mode on, and the model emitted "The vault states that
// the Lunar Mining Colony allocated a total operating budget of $48 billion…"
// with no citation. Model sampling is stochastic, so this proof reproduces the
// EXACT fabrication deterministically: a mock Ollama replays the captured
// Phase 2 sentence as the model output, through the REAL chat pipeline.
//
//   A. zero hits + verbatim $48B vault attribution → CAUGHT (in-stream
//      integrity_warning reason "uncited_claim" + violations-log entry)
//   B. real hit + properly cited vault claim → NOT flagged (negative control)
//   C. zero hits + honest absence statement → NOT flagged (documented carve-out)
//   D. zero hits + fabrication WITHOUT vault attribution → not in scope
//      (documented: the guard covers vault/canon ATTRIBUTION, not all error)
//
// Usage: node scripts/proof-phase3-gate5.mjs   (build first)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7921;
const MOCK_PORT = 11439;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-phase3-gate5-${process.pid}`);

const FABRICATION =
  "The vault states that the Lunar Mining Colony allocated a total operating budget of $48 billion USD for Fiscal Year 2031, with primary expenditures earmarked for habitat expansion.";
const CITED = "The vault states that Rule 1 mandates zero host persistence [1].";
const ABSENCE = "The vault contains no records of that topic, so I cannot answer from it.";
const UNATTRIBUTED = "The Lunar Mining Colony budget for fiscal 2031 is $48 billion USD.";

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

// ---- mock Ollama: reply is selected by the [CASE x] marker in the user turn ----
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/api/chat") {
      let j = null;
      try { j = JSON.parse(body); } catch { /* */ }
      const sys = j?.messages?.[0]?.content ?? "";
      const lastUser = [...(j?.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
      const isExtractor = /fact-extraction tool|Output ONLY a JSON array/i.test(sys);
      let reply = "Acknowledged.";
      if (isExtractor) reply = "[]";
      else if (/\[CASE A\]/.test(lastUser)) reply = FABRICATION;
      else if (/\[CASE B\]/.test(lastUser)) reply = CITED;
      else if (/\[CASE C\]/.test(lastUser)) reply = ABSENCE;
      else if (/\[CASE D\]/.test(lastUser)) reply = UNATTRIBUTED;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { role: "assistant", content: reply }, done: false }) + "\n");
      res.end(JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 100, eval_count: 40 }) + "\n");
    } else if (req.url === "/api/show") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ parameters: "num_ctx                        131072" }));
    } else if (req.url === "/api/embeddings" || req.url === "/api/embed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embedding: Array(768).fill(0.1), embeddings: [Array(768).fill(0.1)] }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }
  });
});

function req(path, { method = "POST", body = null, headers = {}, raw = null } = {}) {
  return new Promise((res) => {
    const payload = raw ?? (body ? Buffer.from(JSON.stringify(body)) : null);
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { ...(raw ? {} : { "content-type": "application/json" }), ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ }
          res({ status: resp.statusCode, json: j, text }); }); });
    r.on("error", () => res({ status: 0, json: null, text: "" }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null, text: "" }); });
    if (payload) r.write(payload); r.end();
  });
}
function chat(content, token, useRetrieval) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({
      messages: [{ role: "user", content }], personaId: "bartimaeus",
      model: "aratan/gemma-4-E4B-q8-it-heretic:latest", useRetrieval, truthMode: true,
    }));
    const u = new URL("/api/chat", BASE);
    let raw = "", status = 0;
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": body.length }, timeout: 120000 },
      (resp) => { status = resp.statusCode ?? 0;
        resp.on("data", (c) => { raw += c.toString("utf8"); });
        resp.on("end", () => {
          const frames = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const content2 = frames.filter((f) => f.message?.content).map((f) => f.message.content).join("");
          res({ status, frames, content: content2 });
        }); });
    r.on("error", () => res({ status, frames: [], content: "" }));
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
const violations = () => {
  try { return fs.readFileSync(join(ROOT, "state", "integrity-violations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

fs.mkdirSync(ROOT, { recursive: true });
await new Promise((res) => mock.listen(MOCK_PORT, "127.0.0.1", res));
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT, OLLAMA_HOST: `127.0.0.1:${MOCK_PORT}` }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const token = v.json?.token;
  if (!token) throw new Error("no session token");

  console.log("=== A. zero hits + verbatim Phase-2 fabrication → CAUGHT ===");
  const a = await chat("[CASE A] What does the vault say about the lunar mining colony budget for fiscal 2031?", token, true);
  const warnA = a.frames.find((f) => f.type === "integrity_warning" && f.reason === "uncited_claim");
  check("in-stream integrity_warning reason=uncited_claim", !!warnA, warnA ? `patterns: ${JSON.stringify(warnA.patterns)}` : "(no frame)");
  check("operator-visible warning appended to content", /UNCITED CLAIM/.test(a.content));
  await new Promise((r) => setTimeout(r, 300));
  const vioA = violations().filter((x) => x.type === "uncited_claim");
  check("violations log has uncited_claim entry", vioA.length >= 1, `(${vioA.length})`);
  if (vioA.length) console.log(`  violation verbatim: ${JSON.stringify({ type: vioA[0].type, persona: vioA[0].persona, patterns: vioA[0].patterns })}`);

  console.log("\n=== B. real hit + cited vault claim → NOT flagged (negative control) ===");
  // Seed one doc through the real upload path (mock embeddings → hit on any query).
  const boundary = "----argosGate5Boundary";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rules.md"\r\nContent-Type: text/markdown\r\n\r\n`;
  const up = await req("/api/vault/upload", {
    raw: Buffer.concat([Buffer.from(head, "utf8"), Buffer.from("Rule 1 mandates zero host persistence for ARGOS.", "utf8"), Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  check("vault doc seeded", up.status === 200, `(status=${up.status})`);
  const b = await chat("[CASE B] What does rule one require?", token, true);
  const retrB = b.frames.find((f) => f.type === "retrieval");
  const warnB = b.frames.find((f) => f.type === "integrity_warning" && f.reason === "uncited_claim");
  check("retrieval produced a hit", (retrB?.hits?.length ?? 0) > 0, `(hits=${retrB?.hits?.length ?? 0})`);
  check("cited claim NOT flagged", !warnB);

  console.log("\n=== C. zero hits + honest absence statement → NOT flagged ===");
  // Fresh root has the seeded doc now — use a query the mock answers with the
  // absence statement; hits may be >0 (mock embeddings make everything match),
  // but the absence sentence carries no attribution-verb violation either way.
  const c = await chat("[CASE C] What does the vault say about submarine procurement?", token, false);
  const warnC = c.frames.find((f) => f.type === "integrity_warning" && f.reason === "uncited_claim");
  check("absence statement NOT flagged", !warnC, `(content: "${c.content.slice(0, 60)}…")`);

  console.log("\n=== D. fabrication WITHOUT vault attribution → out of scope (documented) ===");
  const d = await chat("[CASE D] What is the lunar mining colony budget?", token, false);
  const warnD = d.frames.find((f) => f.type === "integrity_warning" && f.reason === "uncited_claim");
  check("unattributed claim not flagged (scope = vault/canon attribution)", !warnD);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  mock.close();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase3-gate5: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
