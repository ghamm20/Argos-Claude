#!/usr/bin/env node
// proof-phase15-gate.mjs — Phase 1.5 Condition 1 proof (2026-06-10).
//
// Rule 8 restoration evidence, against a REAL `next start` on a throwaway
// ARGOS_ROOT (cold boot — no PIN, no sessions, no runtime-token file):
//
//   (a) un-sessioned POST /api/tools/execute with a WRITE op → 401 REJECTED
//       + audit-logged (event:"auth_denied", entry printed verbatim)
//   (b) sessioned paths still execute:
//         b1. runtime-token (local process) write → ok
//         b2. operator-session bearer (PIN → verify → token) write → ok
//   (c) cold-boot bootstrap completes without deadlock: the PIN is configured
//       via /api/settings and a session minted AFTER the gate is already
//       live — proven by (a) preceding (b2) on the same boot
//   (d) approve endpoint: un-sessioned approve of a REAL pending delete →
//       401 + target survives; sessioned approve executes it
//
// Usage: node scripts/proof-phase15-gate.mjs [--port 7912]   (build first)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { runtimeTokenHeader } from "./lib/runtime-token.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7912;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-phase15-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

function req(path, { method = "POST", body = null, headers = {} } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) },
        timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch { /* */ }
          res({ status: resp.statusCode, json: j }); }); });
    r.on("error", () => res({ status: 0, json: null }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null }); });
    if (payload) r.write(payload); r.end();
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
const toolAudit = () => {
  try { return fs.readFileSync(join(ROOT, "state", "tool-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");

// ---- cold-boot setup: empty root, no PIN, no sessions, no token file ----
fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
fs.writeFileSync(join(ROOT, "workspace", "delete-me.txt"), "pending-delete target", "utf8");

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

const execTool = (params, headers = {}) =>
  req("/api/tools/execute", { body: { toolId: "file_ops", params, personaId: "bartimaeus" }, headers });

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log(`[ready] proof-phase15-gate  ARGOS_ROOT=${ROOT}\n`);

  console.log("=== (a) un-sessioned WRITE → REJECTED + audit-logged ===");
  const a = await execTool({ operation: "write", path: "workspace/attacker.txt", content: "tailscale peer was here" });
  check("un-sessioned write returns 401", a.status === 401, `(status=${a.status})`);
  check("body is ACCESS DENIED", a.json?.error === "ACCESS DENIED", JSON.stringify(a.json));
  check("write did NOT land on disk", !fs.existsSync(join(ROOT, "workspace", "attacker.txt")));
  await new Promise((r) => setTimeout(r, 300));
  const denied = toolAudit().filter((e) => e.event === "auth_denied");
  check("audit has auth_denied entry", denied.length >= 1, `(${denied.length} entries)`);
  if (denied.length) console.log(`  audit verbatim: ${JSON.stringify(denied[denied.length - 1])}`);

  console.log("\n=== (b1) runtime-token (local process) write → executes ===");
  const rtHeaders = runtimeTokenHeader(ROOT);
  const b1 = await execTool({ operation: "write", path: "workspace/local.txt", content: "local runtime token path" }, rtHeaders);
  check("runtime-token write 200 + ok", b1.status === 200 && b1.json?.ok === true, `(status=${b1.status})`);
  check("file written on disk", fs.existsSync(join(ROOT, "workspace", "local.txt")));

  console.log("\n=== (c) cold-boot bootstrap: PIN setup + session mint on a LIVE gate (no deadlock) ===");
  const PIN_HASH = hashPin("4321");
  const s = await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  check("settings POST (PIN setup) 200 — no bootstrap deadlock", s.status === 200, `(status=${s.status})`);
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const token = v.json?.token ?? null;
  check("auth/verify minted session token", v.status === 200 && /^[a-f0-9]{32}$/i.test(token ?? ""), `(status=${v.status})`);

  console.log("\n=== (b2) operator-session bearer write → executes ===");
  const b2 = await execTool({ operation: "write", path: "workspace/operator.txt", content: "operator session path" }, { authorization: `Bearer ${token}` });
  check("sessioned write 200 + ok", b2.status === 200 && b2.json?.ok === true, `(status=${b2.status})`);
  check("file written on disk", fs.existsSync(join(ROOT, "workspace", "operator.txt")));

  console.log("\n=== (d) approve endpoint gated end-to-end ===");
  const del = await execTool({ operation: "delete", path: "workspace/delete-me.txt" }, { authorization: `Bearer ${token}` });
  check("delete queued for approval (sessioned)", del.status === 200 && del.json?.approvalRequired === true && !!del.json?.approvalId);
  const approvalId = del.json?.approvalId;
  const d1 = await req("/api/tools/approve", { body: { approvalId, decision: "approve" } });
  check("un-sessioned approve returns 401", d1.status === 401, `(status=${d1.status})`);
  check("target SURVIVES un-sessioned approve", fs.existsSync(join(ROOT, "workspace", "delete-me.txt")));
  await new Promise((r) => setTimeout(r, 300));
  const deniedApprove = toolAudit().filter((e) => e.event === "auth_denied" && e.toolId === "(tools/approve)");
  check("approve rejection audit-logged", deniedApprove.length >= 1, `(${deniedApprove.length} entries)`);
  if (deniedApprove.length) console.log(`  audit verbatim: ${JSON.stringify(deniedApprove[deniedApprove.length - 1])}`);
  const d2 = await req("/api/tools/approve", { body: { approvalId, decision: "approve" }, headers: { authorization: `Bearer ${token}` } });
  check("sessioned approve executes", d2.status === 200 && d2.json?.result?.ok === true, JSON.stringify(d2.json)?.slice(0, 140));
  check("target deleted after sessioned approve", !fs.existsSync(join(ROOT, "workspace", "delete-me.txt")));
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase15-gate: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
