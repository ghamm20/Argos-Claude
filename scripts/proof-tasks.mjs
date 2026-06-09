#!/usr/bin/env node
// proof-tasks.mjs (Stage 2, 2026-06-09) — end-to-end proof of the task ledger
// through the REAL chat route: a persona (Bobby → routes to hermes3) creates
// two tasks, lists them, and completes one — all via hermes3 TOOL EMISSIONS on
// the production prompt. Shows emissions + the ledger file + audit entries.
//
// tasks is UNGATED (a ledger, no side effects) → emissions run immediately and
// return a tool_result (no approval frame).
//
// Usage: node scripts/proof-tasks.mjs [--port 7894]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7894;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-tasks-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

// Chat (Bobby) → collect content + tool_result frames + backend model.
function chat(userContent) {
  return new Promise((res) => {
    const payload = Buffer.from(JSON.stringify({
      personaId: "bobby", model: "CyberCrew/notmythos-8b:latest",
      messages: [{ role: "user", content: userContent }],
    }));
    const u = new URL("/api/chat", BASE);
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", "content-length": payload.length }, timeout: 120000 },
      (resp) => {
        let buf = "", content = "", backendModel = null; const toolResults = [];
        resp.on("data", (x) => {
          buf += x.toString("utf8");
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const d = JSON.parse(line);
              if (d?.message?.content) content += d.message.content;
              if (d?.type === "backend") backendModel = d.model;
              if (d?.type === "tool_result") toolResults.push(d);
            } catch { /* partial */ }
          }
        });
        resp.on("end", () => res({ content, toolResults, backendModel }));
      });
    r.on("error", () => res({ content: "", toolResults: [], backendModel: null }));
    r.on("timeout", () => { r.destroy(); res({ content: "", toolResults: [], backendModel: null }); });
    r.write(payload); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => {
      http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false));
    });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}
function getJson(path) {
  return new Promise((res) => {
    http.get(new URL(path, BASE), (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }).on("error", () => res(null));
  });
}
function ledger() {
  try {
    return fs.readFileSync(join(ROOT, "state", "tasks", "ledger.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function audit(kind) {
  try {
    return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind);
  } catch { return []; }
}
// Create-via-emission helper: retry until the tasks tool actually ran.
async function createViaEmission(title, due) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await chat(`Use the tasks tool to create a task titled "${title}"${due ? ` due ${due}` : ""}.`);
    const tr = r.toolResults.find((t) => t.toolId === "tasks" && t.ok);
    console.log(`  [create "${title}"] backend=${r.backendModel} emission=${(r.content.match(/<tool>[\s\S]*?<\/tool>/i)?.[0] ?? "(none)").replace(/\s+/g, " ").slice(0, 160)}`);
    if (tr?.data?.task?.id) return { id: tr.data.task.id, summary: tr.summary };
    if (attempt < 3) console.log(`    (attempt ${attempt}: no tasks tool_result; retrying)`);
  }
  return null;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(
  process.execPath,
  [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
);
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-tasks\n");

  console.log("=== persona creates 2 tasks via hermes3 emissions ===");
  const t1 = await createViaEmission("Email Bharath the audit report", "2026-06-15");
  const t2 = await createViaEmission("Renew the argos-ai.dev SSL cert", null);
  check("task 1 created via emission", !!t1?.id, t1?.id);
  check("task 2 created via emission", !!t2?.id, t2?.id);

  console.log("\n=== persona lists open tasks via emission ===");
  let listing = null;
  for (let attempt = 1; attempt <= 3 && !listing; attempt++) {
    const r = await chat("Use the tasks tool to list my open tasks.");
    const tr = r.toolResults.find((t) => t.toolId === "tasks" && t.ok && t.data?.tasks);
    if (tr) listing = tr.data;
    else console.log(`  (list attempt ${attempt}: no listing; retrying)`);
  }
  check("list returned both open tasks", (listing?.count ?? 0) === 2, `count=${listing?.count}`);
  if (listing) console.log("  listing:\n    " + (listing.listing ?? "").split("\n").join("\n    "));

  console.log("\n=== persona completes 1 task via emission ===");
  let completed = false;
  for (let attempt = 1; attempt <= 3 && !completed; attempt++) {
    const r = await chat(`Use the tasks tool to complete task ${t1.id}.`);
    const tr = r.toolResults.find((t) => t.toolId === "tasks" && t.ok);
    console.log(`  [complete ${t1.id}] emission=${(r.content.match(/<tool>[\s\S]*?<\/tool>/i)?.[0] ?? "(none)").replace(/\s+/g, " ").slice(0, 140)}`);
    if (tr) completed = true;
    else if (attempt < 3) console.log(`    (attempt ${attempt}: not completed; retrying)`);
  }
  check("task 1 completed via emission", completed);

  // ---- state file + audit evidence ----
  console.log("\n=== ledger file (state/tasks/ledger.jsonl) ===");
  const led = ledger();
  for (const e of led) console.log("  event:", JSON.stringify(e));
  check("ledger has 2 create events", led.filter((e) => e.op === "create").length === 2);
  check("ledger has 1 complete event", led.filter((e) => e.op === "complete").length === 1);

  console.log("\n=== final state via /api/tasks ===");
  const open = await getJson("/api/tasks?status=open");
  const done = await getJson("/api/tasks?status=completed");
  console.log(`  open=${open?.counts?.open} completed=${open?.counts?.completed}`);
  check("1 task open, 1 completed", open?.counts?.open === 1 && open?.counts?.completed === 1,
    `open=${open?.counts?.open} completed=${open?.counts?.completed}`);
  check("completed task is t1", (done?.tasks ?? []).some((t) => t.id === t1.id));

  console.log("\n=== hash-chained audit entries ===");
  const created = audit("task.created");
  const completedAudit = audit("task.completed");
  console.log(`  task.created x${created.length}, task.completed x${completedAudit.length}`);
  check("2 task.created audit entries (hash-chained)", created.length === 2);
  check("1 task.completed audit entry referencing t1",
    completedAudit.length === 1 && completedAudit[0].payload?.taskId === t1.id,
    completedAudit[0]?.payload?.taskId);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-tasks: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
