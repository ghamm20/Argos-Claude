#!/usr/bin/env node
// proof-phase5-workflow.mjs — Phase 5 gate proof (2026-06-10).
//
//   Gate 1: a 3+ step workflow runs end-to-end with output piping
//           ($prev.data.content feeds a later step).
//   Gate 2: a chain containing a DELETE halts at the approval queue
//           MID-CHAIN (the owner's priority gate — no governance
//           laundering): the delete has not run, nothing after it has run.
//           Reject → clean abort (target survives). Approve → delete
//           executes (restore point) and the chain continues to completion.
//   Gate 3: workflow state survives a PROCESS RESTART — a halted chain
//           persists across a full server kill/respawn and completes after.
//   Rider:  the scheduled proposer pass (preflight-gated, proposals only)
//           runs before the daily brief; the brief carries a PROPOSALS
//           section with predicted-ask classes + probabilities.
//
// R1 COMPLIANCE: this harness never spawns, kills, or parents Ollama; the
// final check asserts the daemon is healthy and was never owned here.
//
// Usage: node scripts/proof-phase5-workflow.mjs   (build first; Ollama up)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7926;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-phase5-${process.pid}`);
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
function chat(content, token, sessionId) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }], personaId: "bartimaeus", model: MODEL_BART, useRetrieval: false, sessionId }));
    const u = new URL("/api/chat", BASE);
    let status = 0;
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": body.length }, timeout: 300000 },
      (resp) => { status = resp.statusCode ?? 0; resp.on("data", () => {}); resp.on("end", () => res({ status })); });
    r.on("error", () => res({ status }));
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

function startServer() {
  const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
  return server;
}
const killServer = (server) => { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { stdio: "ignore" }); } catch { /* */ } };

// ---- fixtures: workspace context for the rider's proposer pass ----
fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
fs.writeFileSync(join(ROOT, "workspace", "stale-cache.tmp"), "stray", "utf8");
fs.mkdirSync(join(ROOT, "tasks", "complete"), { recursive: true });
fs.writeFileSync(
  join(ROOT, "tasks", "complete", "t8-fixture-result.json"),
  JSON.stringify({ taskId: "t8-fixture", goal: "fixture", completedAt: new Date().toISOString(), summary: "1/1", stepsPlanned: 1, stepsOk: 1, steps: [] }, null, 2),
  "utf8"
);

let server = startServer();
try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  let token = v.json?.token;
  if (!token) throw new Error("no session token");
  let bearer = { authorization: `Bearer ${token}` };

  console.log("=== Rule 8: workflows surface gated ===");
  const ungated = await req("/api/workflows", { method: "POST" });
  check("un-sessioned POST /api/workflows → 401", ungated.status === 401, `(status=${ungated.status})`);

  // ---- Gate 1: 3-step chain end-to-end with piping ----
  console.log("\n=== Gate 1: 3-step chain end-to-end (with $prev piping) ===");
  const wf1 = await req("/api/workflows", { method: "POST", headers: bearer, body: {
    title: "gather → read → synthesize report",
    steps: [
      { toolId: "file_ops", params: { operation: "write", path: "workspace/wf-notes.txt", content: "Findings: the night engine, observation corpus, and proposer are live." }, description: "write raw findings" },
      { toolId: "file_ops", params: { operation: "read", path: "workspace/wf-notes.txt" }, description: "read findings back" },
      { toolId: "file_ops", params: { operation: "write", path: "workspace/wf-report.md", content: "$prev.data.content" }, description: "save the synthesized report from step 2 output" },
    ],
  } });
  check("3-step workflow completed end-to-end", wf1.status === 200 && wf1.json?.workflow?.status === "completed", `(status=${wf1.json?.workflow?.status})`);
  const reportText = fs.existsSync(join(ROOT, "workspace", "wf-report.md")) ? fs.readFileSync(join(ROOT, "workspace", "wf-report.md"), "utf8") : "";
  check("output piping: step-3 file carries step-2 content", /Findings: the night engine/.test(reportText), `("${reportText.slice(0, 48)}…")`);

  // ---- Gate 2: delete mid-chain HALTS (no laundering) ----
  console.log("\n=== Gate 2: delete mid-chain halts at the approval queue ===");
  const mkDeleteChain = (suffix) => ({
    title: `chain with embedded delete ${suffix}`,
    steps: [
      { toolId: "file_ops", params: { operation: "write", path: `workspace/wf-temp-${suffix}.txt`, content: "to be deleted, with permission" }, description: "create temp" },
      { toolId: "file_ops", params: { operation: "delete", path: `workspace/wf-temp-${suffix}.txt` }, description: "DELETE — must halt here" },
      { toolId: "file_ops", params: { operation: "write", path: `workspace/wf-after-${suffix}.txt`, content: "step after the delete" }, description: "post-delete step" },
    ],
  });
  const wf2 = await req("/api/workflows", { method: "POST", headers: bearer, body: mkDeleteChain("a") });
  const w2 = wf2.json?.workflow;
  check("chain HALTED at the delete (status halted_approval)", w2?.status === "halted_approval", `(status=${w2?.status})`);
  check("halt is MID-CHAIN at step 2", w2?.cursor === 1, `(cursor=${w2?.cursor})`);
  check("delete did NOT run (target survives)", fs.existsSync(join(ROOT, "workspace", "wf-temp-a.txt")));
  check("nothing after the delete ran", !fs.existsSync(join(ROOT, "workspace", "wf-after-a.txt")));
  console.log(`  halted verbatim: ${JSON.stringify(w2?.halted)}`);

  // Reject path → clean abort.
  const rej = await req("/api/workflows/decide", { method: "POST", headers: bearer, body: { workflowId: w2?.id, decision: "reject" } });
  check("reject → clean abort", rej.status === 200 && rej.json?.workflow?.status === "aborted", `(status=${rej.json?.workflow?.status})`);
  check("rejected: target still survives; tail never ran", fs.existsSync(join(ROOT, "workspace", "wf-temp-a.txt")) && !fs.existsSync(join(ROOT, "workspace", "wf-after-a.txt")));

  // Approve path → delete executes, chain continues to completion.
  const wf3 = await req("/api/workflows", { method: "POST", headers: bearer, body: mkDeleteChain("b") });
  const w3 = wf3.json?.workflow;
  check("second delete-chain halted likewise", w3?.status === "halted_approval");
  const app = await req("/api/workflows/decide", { method: "POST", headers: bearer, body: { workflowId: w3?.id, decision: "approve" } });
  check("approve → delete executed + chain CONTINUED to completion", app.status === 200 && app.json?.workflow?.status === "completed", `(status=${app.json?.workflow?.status})`);
  check("approved: target deleted, post-delete step ran", !fs.existsSync(join(ROOT, "workspace", "wf-temp-b.txt")) && fs.existsSync(join(ROOT, "workspace", "wf-after-b.txt")));

  // ---- Gate 3: state survives a process restart ----
  console.log("\n=== Gate 3: halted state survives server restart ===");
  const wf4 = await req("/api/workflows", { method: "POST", headers: bearer, body: mkDeleteChain("c") });
  const w4 = wf4.json?.workflow;
  check("third delete-chain halted pre-restart", w4?.status === "halted_approval");
  console.log("  killing the server process…");
  killServer(server);
  await sleep(3000);
  server = startServer();
  if (!(await ready())) throw new Error("server did not come back");
  // Sessions are in-memory → re-mint after restart (the PIN persisted).
  const v2 = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  token = v2.json?.token;
  bearer = { authorization: `Bearer ${token}` };
  const list = await req("/api/workflows", { method: "GET", headers: bearer });
  const survived = (list.json?.workflows ?? []).find((w) => w.id === w4?.id);
  check("halted workflow SURVIVED the restart (state intact)", survived?.status === "halted_approval" && survived?.cursor === 1, `(status=${survived?.status}, cursor=${survived?.cursor})`);
  check("target still intact across restart", fs.existsSync(join(ROOT, "workspace", "wf-temp-c.txt")));
  const app2 = await req("/api/workflows/decide", { method: "POST", headers: bearer, body: { workflowId: w4?.id, decision: "approve" } });
  check("post-restart approve completes the chain", app2.status === 200 && app2.json?.workflow?.status === "completed", `(status=${app2.json?.workflow?.status})`);

  // ---- audit trail for the engine ----
  await sleep(300);
  const chain = readJsonl(join(ROOT, "state", "audit", "chain.jsonl"));
  check("audit: workflow.halted entries", chain.filter((e) => e.kind === "workflow.halted").length >= 3, `(${chain.filter((e) => e.kind === "workflow.halted").length})`);
  check("audit: operator-approved step recorded", chain.some((e) => e.kind === "workflow.step" && e.payload?.approvedByOperator === true));
  check("audit: workflow.aborted for the rejection", chain.some((e) => e.kind === "workflow.aborted"));
  check("audit: workflow.completed entries", chain.filter((e) => e.kind === "workflow.completed").length >= 3, `(${chain.filter((e) => e.kind === "workflow.completed").length})`);

  // ---- Rider: scheduled proposer pass + brief PROPOSALS section ----
  console.log("\n=== Rider: scheduled proposer pass → brief PROPOSALS section ===");
  // One research-class chat seeds the corpus AND boots the schedulers; the
  // next 60s tick runs: preflight → proposer pass → morning brief.
  const c = await chat("What is the latest news about backup tooling?", token, "s-rider");
  check("corpus chat 200", c.status === 200);
  let briefMd = "";
  for (let s = 0; s < 150; s += 10) {
    await sleep(10000);
    const b = await req("/api/tasks/brief", { method: "GET" });
    briefMd = b.json?.brief?.content ?? "";
    if (briefMd) break;
  }
  check("scheduled brief generated by the tick", briefMd.length > 0, `(${briefMd.length} chars)`);
  check("brief has PROPOSALS section", /## PROPOSALS/.test(briefMd));
  check("predicted-ask line with class + probability", /- \[research_brief\] .*predicted research_web\/question p=\d\.\d{2}/.test(briefMd));
  check("workspace-context proposal lines present", /workspace context/.test(briefMd));
  const proposalsBlock = (briefMd.split("## PROPOSALS")[1] ?? "").split("##")[0];
  for (const line of proposalsBlock.split("\n").filter((l) => l.startsWith("- "))) console.log(`    ${line}`);
  const chain2 = readJsonl(join(ROOT, "state", "audit", "chain.jsonl"));
  const sched = chain2.filter((e) => e.kind === "proposal.scheduled_pass");
  check("audit: proposal.scheduled_pass recorded (preflight-gated path)", sched.length >= 1, sched.length ? `(payload: ${JSON.stringify(sched[0].payload)})` : "");
  // Proposals only — nothing executed by the scheduled pass.
  check("rider: stray .tmp untouched by the scheduled pass", fs.existsSync(join(ROOT, "workspace", "stale-cache.tmp")));

  // ---- R1 ----
  const daemonUp = await (async () => { try { const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; } })();
  check("R1: daemon healthy and never owned by this harness", daemonUp);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  killServer(server);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase5-workflow: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
