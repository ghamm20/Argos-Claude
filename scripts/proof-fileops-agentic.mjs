#!/usr/bin/env node
// proof-fileops-agentic.mjs (Stage 1, 2026-06-09) — end-to-end proof of the
// agentic file_ops capability through the REAL chat route + governance:
//
//   1. hermes3 (the tool model) emits a file_ops BATCH for a multi-step
//      request, via /api/chat on the production prompt.
//   2. The batch returns ONE approval with a dry-run MANIFEST (mkdir + move).
//   3. Operator approves → both ops run; ONE audit entry PER op.
//   4. The resulting tree is verified (folder created, file moved).
//   5. Restore-point proof: delete a file (approval → restore point), then
//      restore it; both audit entries shown.
//
// Throwaway ARGOS_ROOT + real next-start server (validate-script harness).
//
// Usage: node scripts/proof-fileops-agentic.mjs [--port 7893]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";
import { runtimeTokenHeader } from "./lib/runtime-token.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7893;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-fileops-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

function jsonReq(method, path, body) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...runtimeTokenHeader(ROOT), ...(payload ? { "content-length": payload.length } : {}) }, timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { try { res({ status: resp.statusCode, json: JSON.parse(Buffer.concat(c).toString("utf8")) }); } catch { res({ status: resp.statusCode, json: null }); } }); });
    r.on("error", () => res({ status: 0, json: null }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null }); });
    if (payload) r.write(payload); r.end();
  });
}
// Stream /api/chat (NDJSON); collect content + the tool_approval_required frame.
function chat(messages) {
  return new Promise((res) => {
    // Bobby: scoped operational persona that holds file_ops + shell_exec. A
    // tool turn routes the MODEL to hermes3 (default toolExecutionModel) while
    // injecting Bobby's lean, ops-focused prompt — close to the scoped block
    // the emission harness validated. (Bartimaeus' full "*" prompt is far
    // heavier; see Stage 1 report.)
    const payload = Buffer.from(JSON.stringify({ personaId: "bobby", model: "CyberCrew/notmythos-8b:latest", messages }));
    const u = new URL("/api/chat", BASE);
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", "content-length": payload.length }, timeout: 120000 },
      (resp) => {
        let buf = "", content = "", approval = null, backendModel = null, toolResult = null;
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
              if (d?.type === "tool_approval_required") approval = d;
              if (d?.type === "tool_result" && d?.toolId === "file_ops") toolResult = d;
            } catch { /* partial */ }
          }
        });
        resp.on("end", () => res({ content, approval, backendModel, toolResult }));
      });
    r.on("error", () => res({ content: "", approval: null, backendModel: null, toolResult: null }));
    r.on("timeout", () => { r.destroy(); res({ content: "", approval: null, backendModel: null, toolResult: null }); });
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
function toolAudit() {
  try {
    return fs.readFileSync(join(ROOT, "state", "tool-audit.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// Seed the file the batch will move.
fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
fs.writeFileSync(join(ROOT, "workspace", "harness-test.txt"), "HARNESS_OK seed", "utf8");

const server = spawn(
  process.execPath,
  [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
);
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-fileops-agentic\n");

  // ---- 1+2: multi-step request → batch emission → SESSION-GATED auto-execute ----
  // Phase 1 locked tiers: a mkdir+move batch (no delete) is SESSION-GATED — it
  // auto-executes in the operator session, no approval pause. (Approval +
  // manifest are exercised on the delete below.)
  console.log("=== multi-step request through hermes3 (tool model) ===");
  const beforeAudit = toolAudit().length;
  let toolResult = null, emission = "", backendModel = null;
  for (let attempt = 1; attempt <= 3 && !toolResult; attempt++) {
    const r = await chat([
      { role: "user",
        content: "Use file_ops to do BOTH in one step: create the folder workspace/reports/2026, and move workspace/harness-test.txt into it." },
    ]);
    toolResult = r.toolResult; emission = r.content; backendModel = r.backendModel;
    if (!toolResult) console.log(`  (attempt ${attempt}: backend=${r.backendModel}; no tool_result; retrying)`);
  }
  console.log(`  answering model (backend frame): ${backendModel}`);
  check("turn routed to the tool model (hermes3:8b)", backendModel === "hermes3:8b", `model=${backendModel}`);
  console.log("  model emission (excerpt):", (emission.match(/<tool>[\s\S]*?<\/tool>/i)?.[0] ?? emission).replace(/\s+/g, " ").slice(0, 220));
  check("batch AUTO-EXECUTED (session-gated, no approval pause)", !!toolResult && toolResult.ok === true,
    toolResult ? toolResult.summary : "none");
  if (!toolResult) {
    console.log("\n[halt] no tool_result — cannot verify execution. Reporting honestly.");
    throw new Error("tool emission did not produce a tool_result");
  }

  // ---- 4: verify the tree ----
  console.log("\n=== resulting tree ===");
  const movedTo = join(ROOT, "workspace", "reports", "2026", "harness-test.txt");
  const oldGone = !fs.existsSync(join(ROOT, "workspace", "harness-test.txt"));
  check("folder workspace/reports/2026 created", fs.existsSync(join(ROOT, "workspace", "reports", "2026")));
  check("harness-test.txt moved into it", fs.existsSync(movedTo), movedTo.replace(ROOT, "<ROOT>"));
  check("original location no longer has the file", oldGone);

  // ---- per-op audit entries ----
  console.log("\n=== audit entries (one per op) ===");
  const aud = toolAudit().slice(beforeAudit);
  const batchOps = aud.filter((e) => /^\[batch \d+\/\d+\]/.test(e.summary));
  for (const e of batchOps) console.log("  audit:", e.summary, `(ok=${e.ok}, approved=${e.approved})`);
  check("a per-op audit entry for mkdir", batchOps.some((e) => /\bmkdir\b|created directory/.test(e.summary)));
  check("a per-op audit entry for move", batchOps.some((e) => /\bmoved\b/.test(e.summary)));

  // ---- 5: restore-point proof (delete → restore) ----
  console.log("\n=== restore-point proof: delete then restore ===");
  // Approve-gated delete via /api/tools/execute (file_ops delete → restore point).
  fs.writeFileSync(join(ROOT, "workspace", "to-delete.txt"), "DELETE_ME_THEN_RESTORE", "utf8");
  const delReq = await jsonReq("POST", "/api/tools/execute", {
    toolId: "file_ops", params: { operation: "delete", path: "workspace/to-delete.txt" },
  });
  check("delete requires approval", delReq.json?.approvalRequired === true, `approvalId=${delReq.json?.approvalId}`);
  const beforeDel = toolAudit().length;
  const delDone = await jsonReq("POST", "/api/tools/approve", { approvalId: delReq.json.approvalId, decision: "approve" });
  const restorePointId = delDone.json?.result?.restorePointId;
  check("delete executed + restore point created",
    delDone.json?.result?.ok === true && !!restorePointId && !fs.existsSync(join(ROOT, "workspace", "to-delete.txt")),
    `restorePointId=${restorePointId}`);
  const delEntry = toolAudit().slice(beforeDel).find((e) => /deleted workspace\/to-delete\.txt/.test(e.summary));
  console.log("  delete audit:", delEntry ? `${delEntry.summary} (restorePointId=${delEntry.restorePointId})` : "(missing)");
  check("delete audit entry carries the restore point id", !!delEntry?.restorePointId, delEntry?.restorePointId ?? "none");

  const beforeRestore = toolAudit().length;
  const restoreRes = await jsonReq("POST", "/api/tools/restore", { restoreId: restorePointId });
  check("restore → ok, file is back",
    restoreRes.json?.ok === true && fs.existsSync(join(ROOT, "workspace", "to-delete.txt")) &&
    fs.readFileSync(join(ROOT, "workspace", "to-delete.txt"), "utf8") === "DELETE_ME_THEN_RESTORE",
    JSON.stringify(restoreRes.json));
  const restoreEntry = toolAudit().slice(beforeRestore).find((e) => /restored \d+ file/.test(e.summary));
  console.log("  restore audit:", restoreEntry ? restoreEntry.summary : "(missing)");
  check("restore audit entry written (both entries present)", !!restoreEntry, restoreEntry?.summary ?? "none");
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-fileops-agentic: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
