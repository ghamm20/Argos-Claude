#!/usr/bin/env node
// proof-phase2-live.mjs — Phase 2 Gate 2 live proof (2026-06-10).
//
// Against a REAL `next start` (throwaway ARGOS_ROOT) + REAL Ollama:
//   A. All 4 personas answer live (operator session, each on its bound
//      model; the backend frame must echo the expected model).
//   B. Vault retrieval cites correctly: a seeded doc is retrieved (hits>0)
//      and every [N] citation in the reply points inside the hit list.
//   C. False-citation gate still 0: a no-coverage query must not produce
//      citations pointing at nothing (no [N] when hits=0; in-range only
//      otherwise).
//
// Usage: node scripts/proof-phase2-live.mjs   (build first; Ollama running)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7918;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-phase2-live-${process.pid}`);

const MODEL_BART = "aratan/gemma-4-E4B-q8-it-heretic:latest";
const MODEL_JUNIPER = "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b";
const MODEL_BOBBY = "CyberCrew/notmythos-8b:latest";

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

function req(path, { method = "POST", body = null, headers = {}, raw = null } = {}) {
  return new Promise((res) => {
    const payload = raw ?? (body ? Buffer.from(JSON.stringify(body)) : null);
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { ...(raw ? {} : { "content-type": "application/json" }), ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 300000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ }
          res({ status: resp.statusCode, json: j, text }); }); });
    r.on("error", (e) => res({ status: 0, json: null, text: String(e) }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null, text: "timeout" }); });
    if (payload) r.write(payload); r.end();
  });
}
// Stream /api/chat; collect content + typed frames.
function chat(payload, token) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify(payload));
    const u = new URL("/api/chat", BASE);
    const headers = { "content-type": "application/json", "content-length": body.length };
    if (token) headers["authorization"] = `Bearer ${token}`;
    let content = "", status = 0;
    const frames = [];
    let buf = "";
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers, timeout: 300000 },
      (resp) => { status = resp.statusCode ?? 0;
        resp.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (line) { try { const j = JSON.parse(line); frames.push(j); if (j.message?.content) content += j.message.content; } catch { /* */ } }
            nl = buf.indexOf("\n");
          }
        });
        resp.on("end", () => res({ status, content, frames })); });
    r.on("error", () => res({ status, content, frames }));
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
// All [N] citation indices present in a reply.
const citedIndices = (text) => [...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => parseInt(m[1], 10));

const SAMPLE_DOC = [
  "# ARGOS Seven USB-Native Rules (sample corpus)",
  "",
  "Rule 1 mandates zero host persistence: ARGOS leaves nothing on the host machine.",
  "Rule 2 forbids registry writes of any kind on Windows hosts.",
  "Rule 3 requires relative path discipline: every path resolves from ARGOS_ROOT, never an absolute host path.",
  "Rule 4 scopes environment variables to the launcher process only.",
  "Rule 5 keeps networking off by default; only loopback services are started.",
  "Rule 6 demands graceful eject: all file handles close cleanly on shutdown.",
  "Rule 7 is the single-binary mentality: the payload travels as one self-contained tree.",
].join("\n");

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const token = v.json?.token;
  if (!token) throw new Error("no session token");

  // ---- seed the vault through the REAL upload/ingest path ----
  const boundary = "----argosPhase2LiveBoundary";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="seven-rules-sample.md"\r\nContent-Type: text/markdown\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const up = await req("/api/vault/upload", {
    raw: Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(SAMPLE_DOC, "utf8"), Buffer.from(tail, "utf8")]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  check("vault doc seeded via /api/vault/upload", up.status === 200, `(status=${up.status})`);

  // ---- A. all 4 personas live ----
  console.log("\n=== A. four personas live (operator, bound models) ===");
  // Expected ANSWERING model per persona: useReboundModels defaults TRUE
  // (Phase 1 flip, lib/settings.ts DEFAULT_SETTINGS) → Juniper + Bobby rebind
  // to the resident gemma-4 (REBOUND_MODEL, lib/inference-backend.ts). The
  // requested body.model is still each persona's binding from lib/personas.ts.
  const personas = [
    { id: "bartimaeus", model: MODEL_BART, expect: MODEL_BART },
    { id: "juniper", model: MODEL_JUNIPER, expect: MODEL_BART },
    { id: "sage", model: MODEL_BART, expect: MODEL_BART },
    { id: "bobby", model: MODEL_BOBBY, expect: MODEL_BART },
  ];
  for (const p of personas) {
    const c = await chat({ personaId: p.id, model: p.model, useRetrieval: false, messages: [{ role: "user", content: "Identify yourself in one short sentence." }] }, token);
    const backend = c.frames.find((f) => f.type === "backend");
    check(`${p.id} live (200, >20 chars)`, c.status === 200 && c.content.length > 20, `(${c.content.length} chars)`);
    check(`${p.id} answered on expected model (rebound-aware)`, backend?.model === p.expect, `(backend=${backend?.backend} model=${backend?.model})`);
    console.log(`    ${p.id}: "${c.content.slice(0, 110).replace(/\s+/g, " ")}…"`);
  }

  // ---- B. retrieval cites correctly ----
  console.log("\n=== B. vault retrieval + correct citation ===");
  const b = await chat({ personaId: "bartimaeus", model: MODEL_BART, useRetrieval: true, truthMode: true, messages: [{ role: "user", content: "According to the vault, what does the rule about zero host persistence and relative path discipline require? Cite your sources." }] }, token);
  const retr = b.frames.find((f) => f.type === "retrieval");
  const hitCount = retr?.hits?.length ?? 0;
  check("retrieval event present + hits > 0", retr?.enabled === true && hitCount > 0, `(hits=${hitCount})`);
  const citesB = citedIndices(b.content);
  check("reply cites the vault", citesB.length > 0, `(citations: [${citesB.join("],[")}])`);
  check("every citation within hit range (no false citation)", citesB.every((n) => n >= 1 && n <= hitCount), `(hits=${hitCount})`);
  console.log(`    reply: "${b.content.slice(0, 160).replace(/\s+/g, " ")}…"`);

  // ---- C. false-citation gate: 0 invented citations on a no-coverage query ----
  console.log("\n=== C. false-citation gate (no-coverage query) ===");
  const c2 = await chat({ personaId: "bartimaeus", model: MODEL_BART, useRetrieval: true, truthMode: true, messages: [{ role: "user", content: "What does the vault say about the lunar mining colony budget for fiscal 2031?" }] }, token);
  const retr2 = c2.frames.find((f) => f.type === "retrieval");
  const hits2 = retr2?.hits?.length ?? 0;
  const cites2 = citedIndices(c2.content);
  const falseCites = cites2.filter((n) => n < 1 || n > hits2);
  check("no-coverage reply is non-empty (honest answer, not silence)", c2.content.trim().length > 20, `(${c2.content.trim().length} chars)`);
  check("zero false citations (every [N] backed by a real hit)", falseCites.length === 0, `(hits=${hits2}, citations=[${cites2.join(",")}], false=${falseCites.length})`);
  console.log(`    reply: "${c2.content.slice(0, 160).replace(/\s+/g, " ")}…"`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase2-live: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
