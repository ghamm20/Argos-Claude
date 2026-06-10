#!/usr/bin/env node
// proof-phase6-crash.mjs — Phase 6 hardening (owner rider, 2026-06-10):
// MID-STEP CRASH RECOVERY. Kill the server DURING workflow step execution
// (not at a halt). Prove:
//   1. the on-disk state captured the crash point (status "running",
//      completed steps' results persisted),
//   2. boot-resume re-runs the IN-FLIGHT step and continues to completion,
//   3. COMPLETED steps do NOT re-run (audit: exactly one workflow.step
//      entry for step 1; the step-1 artifact's mtime is unchanged).
//
// R1 COMPLIANT: never touches Ollama.
// Usage: node scripts/proof-phase6-crash.mjs   (build first; Ollama up)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7928;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-phase6-crash-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");
const readJsonl = (p) => { try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

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
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}
function startServer() {
  const s = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  s.stdout.on("data", () => {}); s.stderr.on("data", () => {});
  return s;
}
const killServer = (s) => { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(s.pid)], { stdio: "ignore" }); } catch { /* */ } };

fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
let server = startServer();
try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const bearer = { authorization: `Bearer ${v.json?.token}` };

  console.log("=== Launch chain, kill DURING step 2 (web_search in flight) ===");
  // Fire the POST without awaiting — the route runs the chain synchronously.
  void req("/api/workflows", { method: "POST", headers: bearer, body: {
    title: "crash-recovery chain",
    steps: [
      { toolId: "file_ops", params: { operation: "write", path: "workspace/crash-step1.txt", content: "step one artifact" }, description: "fast step" },
      { toolId: "chain_search_to_read", params: { query: "Node.js LTS release schedule details" }, description: "slow in-flight step (search + page reads, multi-second)" },
      { toolId: "file_ops", params: { operation: "write", path: "workspace/crash-step3.txt", content: "step three artifact" }, description: "tail step" },
    ],
  } });
  await sleep(1500); // step 1 (~50ms) done; step 2 (multi-fetch) in flight
  killServer(server);
  console.log("  server killed at t+1.5s");
  await sleep(2000);

  const wfDir = join(ROOT, "state", "workflows");
  const wfFiles = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((n) => n.endsWith(".json")) : [];
  check("workflow state file persisted through the crash", wfFiles.length === 1, `(${wfFiles.length})`);
  const wfPath = join(wfDir, wfFiles[0]);
  const crashed = JSON.parse(fs.readFileSync(wfPath, "utf8"));
  check("crash captured mid-run (status running, cursor past step 1)", crashed.status === "running" && crashed.cursor >= 1, `(status=${crashed.status}, cursor=${crashed.cursor})`);
  check("completed step-1 result persisted", crashed.results?.[0]?.ok === true);
  const step1Mtime = fs.statSync(join(ROOT, "workspace", "crash-step1.txt")).mtimeMs;
  const crashCursor = crashed.cursor;

  console.log("\n=== Restart → boot-resume re-runs the in-flight step ===");
  server = startServer();
  if (!(await ready())) throw new Error("server did not come back");
  const v2 = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  // Boot kickers (incl. resumeInterruptedWorkflows) load with the chat route
  // module — one minimal chat request triggers them. 404-model is fine; the
  // module load is what matters.
  await req("/api/chat", { method: "POST", headers: { authorization: `Bearer ${v2.json?.token}` }, body: { messages: [{ role: "user", content: "ping" }], personaId: "bartimaeus", model: "aratan/gemma-4-E4B-q8-it-heretic:latest", useRetrieval: false }, timeoutMs: 120000 });
  let final = null;
  for (let s = 0; s < 90; s += 3) {
    final = JSON.parse(fs.readFileSync(wfPath, "utf8"));
    if (final.status !== "running") break;
    await sleep(3000);
  }
  check("workflow COMPLETED after restart (in-flight step re-ran)", final?.status === "completed", `(status=${final?.status})`);
  check("tail step ran post-resume", fs.existsSync(join(ROOT, "workspace", "crash-step3.txt")));
  check("all step results filled", (final?.results ?? []).every((r) => r?.ok === true), `(${(final?.results ?? []).map((r) => r?.ok).join(",")})`);

  console.log("\n=== Completed steps did NOT re-run ===");
  const step1MtimeAfter = fs.statSync(join(ROOT, "workspace", "crash-step1.txt")).mtimeMs;
  check("step-1 artifact mtime unchanged (no re-run)", step1MtimeAfter === step1Mtime, `(Δ=${step1MtimeAfter - step1Mtime}ms)`);
  const chain = readJsonl(join(ROOT, "state", "audit", "chain.jsonl"));
  const step1Entries = chain.filter((e) => e.kind === "workflow.step" && e.payload?.step === 1);
  check("audit: exactly ONE workflow.step entry for step 1", step1Entries.length === 1, `(${step1Entries.length})`);
  check("audit: workflow.resumed entry (process_restart)", chain.some((e) => e.kind === "workflow.resumed" && e.payload?.reason === "process_restart"), `(resumed at step ${chain.find((e) => e.kind === "workflow.resumed")?.payload?.atStep})`);
  console.log(`  crash cursor=${crashCursor} → resumed from step ${crashCursor + 1}`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  killServer(server);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase6-crash: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
