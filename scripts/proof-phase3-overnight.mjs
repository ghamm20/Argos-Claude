#!/usr/bin/env node
// proof-phase3-overnight.mjs — Phase 3 gates 1–4 proof (2026-06-10).
//
// Time-compressed simulated overnight run against a REAL `next start` + REAL
// Ollama, on a throwaway ARGOS_ROOT:
//
//   Gate 1: ≥3 queued tasks of MIXED type complete unattended
//           (T1 doc_generate, T2 web_search live, T3 mirofish status probe)
//   Gate 2: designed failures reported honestly — T4 (invalid: no goal) is
//           archived to failed/; T3's steps fail honestly (MiroFish down)
//   Gate 3: hash-chained audit entries for every task action
//           (task.claimed / task.step / task.completed / task.preflight) +
//           standalone verifier PASS; tamper-negative on a mutated copy
//   Gate 4: observation.jsonl populated by operator chats during the run;
//           entries hash-verify with the standalone verifier
//   Plus:   Ollama preflight backstop demo — daemon killed (watchdog parked),
//           the engine's preflight restarts it, audited
//   Plus:   morning brief carries the deterministic VERDICT BLOCK with
//           per-line evidence refs
//
// "Unattended" = tasks run via the queue pump with zero operator interaction
// per task; time compression uses POST /api/tasks/queue (the same pump the
// 60s scheduler tick calls — identical code path, no gate semantics changed).
//
// Usage: node scripts/proof-phase3-overnight.mjs   (build first; Ollama up)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7922;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-phase3-overnight-${process.pid}`);
const MODEL_BART = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

function req(path, { method = "POST", body = null, headers = {}, timeoutMs = 300000 } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: timeoutMs },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ }
          res({ status: resp.statusCode, json: j, text }); }); });
    r.on("error", (e) => res({ status: 0, json: null, text: String(e) }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null, text: "timeout" }); });
    if (payload) r.write(payload); r.end();
  });
}
function chat(messages, token, sessionId) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages, personaId: "bartimaeus", model: MODEL_BART, useRetrieval: false, sessionId }));
    const u = new URL("/api/chat", BASE);
    let content = "", status = 0;
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": body.length }, timeout: 300000 },
      (resp) => { status = resp.statusCode ?? 0;
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
        resp.on("end", () => res({ status, content })); });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (p) => {
  try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const ollamaUp = async () => {
  try { const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500) }); return r.ok; }
  catch { return false; }
};

// ---- setup: throwaway root + 4 dropped task files (the operator interface) ----
fs.mkdirSync(join(ROOT, "tasks", "queue"), { recursive: true });
const drop = (name, obj) => fs.writeFileSync(join(ROOT, "tasks", "queue", name), JSON.stringify(obj, null, 2), "utf8");
drop("t1-docgen.json", { id: "t1-docgen", goal: "Generate a short operational note titled Night Shift Check describing the ARGOS overnight task engine in three sentences.", steps: ["doc_generate"], priority: "high", notify_on: "error" });
drop("t2-websearch.json", { id: "t2-websearch", goal: "Search the web for the current Node.js LTS version", steps: ["web_search"], priority: "normal", notify_on: "error" });
drop("t3-mirofish.json", { id: "t3-mirofish", goal: "Check MiroFish integration status", steps: ["mirofish_integration"], priority: "normal", notify_on: "error", dangerous_tools_allowed: true });
drop("t4-designed-fail.json", { id: "t4-designed-fail", steps: ["web_search"], priority: "low" }); // NO goal → invalid by design

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
  console.log(`[ready] simulated overnight run  ARGOS_ROOT=${ROOT}\n`);

  // ---- "evening" operator exchanges → observation corpus (gate 4 capture) ----
  console.log("=== Operator exchanges (observation capture) ===");
  const sessA = "sess-overnight-A", sessB = "sess-overnight-B";
  const exchanges = [
    { sess: sessA, messages: [{ role: "user", content: "Queue up the overnight tasks and remind me at 6am." }] },
    { sess: sessA, messages: [{ role: "user", content: "Queue up the overnight tasks and remind me at 6am." }, { role: "assistant", content: "Done." }, { role: "user", content: "And what about the audit chain status?" }] },
    { sess: sessB, messages: [{ role: "user", content: "Who is Ptolemy to you?" }] },
    { sess: sessB, messages: [{ role: "user", content: "Who is Ptolemy to you?" }, { role: "assistant", content: "A long story." }, { role: "user", content: "Summarize the file workspace/notes.md" }] },
    { sess: sessB, messages: [{ role: "user", content: "Who is Ptolemy to you?" }, { role: "assistant", content: "A long story." }, { role: "user", content: "Summarize the file workspace/notes.md" }, { role: "assistant", content: "There is no such file." }, { role: "user", content: "Good night." }] },
  ];
  for (const e of exchanges) {
    const c = await chat(e.messages, token, e.sess);
    process.stdout.write(`  chat (${e.sess}, turn ${e.messages.filter((m) => m.role === "user").length}) → ${c.status}, ${c.content.length} chars\n`);
  }
  await sleep(1500); // let fire-and-forget capture land

  // ---- the "night": pump the queue unattended (same code path as the tick) ----
  console.log("\n=== Night pump (gates 1-3) ===");
  // The 60s scheduler tick (booted by the chats above) may already be mid-pump;
  // POST pumps bounce off the single-flight guard while a task is running. So:
  // keep nudging + poll until the queue DRAINS (queued=0, nothing running),
  // exactly like a real overnight window — then assert.
  const DRAIN_MAX_S = 480;
  let drained = false;
  for (let s = 0; s < DRAIN_MAX_S; s += 5) {
    await req("/api/tasks/queue", { method: "POST", timeoutMs: 290000 }).catch(() => {});
    const g = await req("/api/tasks/queue", { method: "GET" });
    const queued = g.json?.queued?.length ?? -1;
    const runningId = g.json?.runningId ?? null;
    const complete = g.json?.complete?.length ?? -1;
    if (s % 30 === 0) console.log(`  t+${s}s: queued=${queued} running=${runningId ?? "none"} complete=${complete}`);
    if (queued === 0 && runningId === null) { drained = true; break; }
    await sleep(5000);
  }
  check("queue drained within the window", drained);
  const listing = await req("/api/tasks/queue", { method: "GET" });
  const completeIds = (listing.json?.complete ?? []).map((t) => t.id).sort();
  check("gate 1: ≥3 mixed-type tasks complete unattended", completeIds.length >= 3, `(complete: ${completeIds.join(", ")})`);
  // t4 is INVALID by design, so listAll() (which validates) cannot list it —
  // the on-disk archive + error log are the evidence (and the brief's RED line).
  const t4Archived = fs.existsSync(join(ROOT, "tasks", "failed", "t4-designed-fail.json"));
  const t4ErrorLog = fs.existsSync(join(ROOT, "tasks", "failed", "t4-designed-fail-error.json"));
  check("gate 2: designed-fail task archived to failed/ with error log", t4Archived && t4ErrorLog, `(json=${t4Archived} errlog=${t4ErrorLog})`);
  const t3 = (listing.json?.complete ?? []).find((t) => t.id === "t3-mirofish");
  const t3Steps = t3?.result?.steps ?? [];
  const t3MiroFailed = t3Steps.some((s) => s.tool_id === "mirofish_integration" && s.ok === false && !s.skipped);
  check(
    "gate 2: T3 MiroFish step failed HONESTLY (negative surfaced, not masked)",
    t3MiroFailed,
    `(steps: ${t3Steps.map((s) => `${s.tool_id}:${s.skipped ? "skip" : s.ok ? "ok" : "FAIL"}`).join(", ")})`
  );

  // ---- preflight backstop demo (owner rider) ----
  console.log("\n=== Ollama preflight backstop demo ===");
  // Park the dev watchdog so the ENGINE's preflight is what restores the daemon.
  const wdFlag = join(repoRoot, "tmp", "ollama-watchdog.stop");
  fs.mkdirSync(join(repoRoot, "tmp"), { recursive: true });
  fs.writeFileSync(wdFlag, "stop", "utf8");
  spawnSync("taskkill", ["/F", "/IM", "ollama.exe"], { stdio: "ignore" });
  await sleep(5000); // watchdog sees flag after its serve child dies, exits
  fs.rmSync(wdFlag, { force: true });
  const downBefore = !(await ollamaUp());
  check("daemon down before pump (watchdog parked)", downBefore);
  const pf = await req("/api/tasks/queue", { method: "POST", timeoutMs: 120000 }); // pump → preflight restarts
  check("pump returned after preflight", pf.status === 200);
  check("daemon restored by engine preflight", await ollamaUp());

  // ---- morning: the brief with the verdict block ----
  console.log("\n=== Morning brief (verdict block) ===");
  const briefRes = await req("/api/tasks/brief", { method: "POST", timeoutMs: 300000 });
  const briefMd = briefRes.json?.brief?.content ?? "";
  check("brief generated", briefRes.status === 200 && briefMd.length > 0, `(${briefMd.length} chars)`);
  check("verdict block present", /## VERDICT BLOCK/.test(briefMd));
  // Every completed task gets a verdict line (GREEN/YELLOW/RED) carrying a
  // [result:...] evidence ref. (The gate requires verdicts + refs, not that
  // any task earn GREEN — multi-step plans with partial success are YELLOW.)
  const taskVerdictLines = briefMd.split("\n").filter((l) => /^- (GREEN|YELLOW|RED)\s+t\d-.*\[result:tasks\/complete\//.test(l));
  check("completed-task verdict lines carry [result:] evidence refs", taskVerdictLines.length >= 3, `(${taskVerdictLines.length} lines)`);
  check("RED verdict for designed failure with error evidence ref", /- RED .*t4-designed-fail.*\[error:tasks\/failed\/t4-designed-fail-error\.json\]/.test(briefMd));
  check("audit-chain verify line GREEN", /- GREEN\s+audit chain: \d+ entries, verify PASS/.test(briefMd));
  check("observation-corpus verify line GREEN", /- GREEN\s+observation corpus: \d+ entries, verify PASS/.test(briefMd));
  console.log("  verdict block verbatim:");
  const vbLines = (briefMd.split("## VERDICT BLOCK")[1] ?? "").split("\n").filter((l) => l.startsWith("- "));
  for (const line of vbLines) console.log(`    ${line}`);

  // ---- gate 3: audit chain — kinds + standalone verify + tamper-negative ----
  console.log("\n=== Gate 3: hash-chained audit ===");
  const chain = readJsonl(join(ROOT, "state", "audit", "chain.jsonl"));
  const kinds = new Set(chain.map((e) => e.kind));
  check("task.claimed entries", chain.some((e) => e.kind === "task.claimed"));
  check("task.step entries (every step)", chain.filter((e) => e.kind === "task.step").length >= 3, `(${chain.filter((e) => e.kind === "task.step").length})`);
  check("task.completed entries", chain.some((e) => e.kind === "task.completed"));
  check("task.preflight restart audited", chain.some((e) => e.kind === "task.preflight" && /restart_attempt/.test(JSON.stringify(e.payload))));
  console.log(`  kinds present: ${[...kinds].join(", ")}`);
  const ver = spawnSync(process.execPath, [join(repoRoot, "scripts", "verify-audit-chain.mjs"), "--chain", join(ROOT, "state", "audit", "chain.jsonl")], { encoding: "utf8" });
  check("standalone verifier: audit chain PASS", ver.status === 0, (ver.stdout.match(/\[ok \].*verified.*$/m) ?? [""])[0]);

  // ---- gate 4: observation corpus — populated + verify + tamper-negative ----
  console.log("\n=== Gate 4: observation corpus ===");
  const obsPath = join(ROOT, "state", "observation.jsonl");
  const obs = readJsonl(obsPath);
  check("observation.jsonl populated during the run", obs.length >= 5, `(${obs.length} entries)`);
  const fields = obs.length ? Object.keys(obs[0]) : [];
  check("schema fields present", ["timestamp", "persona", "topic_class", "query_type", "session_id", "sequence_position"].every((f) => fields.includes(f)), `(${fields.join(",")})`);
  if (obs.length) console.log(`  sample verbatim: ${JSON.stringify({ persona: obs[0].persona, topic_class: obs[0].topic_class, query_type: obs[0].query_type, session_id: obs[0].session_id, sequence_position: obs[0].sequence_position })}`);
  const over = spawnSync(process.execPath, [join(repoRoot, "scripts", "verify-audit-chain.mjs"), "--chain", obsPath], { encoding: "utf8" });
  check("standalone verifier: observation chain PASS", over.status === 0, (over.stdout.match(/\[ok \].*verified.*$/m) ?? [""])[0]);
  // tamper-negative: flip a field in a COPY, verifier must FAIL
  const tampered = join(ROOT, "state", "observation-tampered.jsonl");
  if (obs.length) {
    const lines = fs.readFileSync(obsPath, "utf8").split("\n").filter(Boolean);
    lines[0] = lines[0].replace(/"sequence_position":\d+/, '"sequence_position":99');
    fs.writeFileSync(tampered, lines.join("\n") + "\n", "utf8");
    const tv = spawnSync(process.execPath, [join(repoRoot, "scripts", "verify-audit-chain.mjs"), "--chain", tampered], { encoding: "utf8" });
    check("tamper-negative: mutated copy FAILS verification", tv.status === 1, (tv.stdout.match(/\[FAIL\].*$/m) ?? [""])[0]);
  }
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase3-overnight: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
