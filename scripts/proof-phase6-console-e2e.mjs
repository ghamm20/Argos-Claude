#!/usr/bin/env node
// proof-phase6-console-e2e.mjs — Phase 7 R2 (owner rider): console
// decision-button click-through, end to end.
//
// Drives the EXACT requests the Workspace console's Approve/Reject buttons
// issue (the handlers in app/workspace/page.tsx: POST /api/proposals/decide
// and /api/workflows/decide with the operator bearer), against a REAL
// `next start` on an isolated port + fixture ARGOS_ROOT, and asserts the
// server-side effects + audit. The buttons are thin wrappers over these
// fetches; this proves the wired path works without depending on the
// shared-.next preview server (which a background `next dev` was clobbering).
//
// Console render + button presence is separately proven by the Phase 6
// accessibility-tree snapshot. R1 (daemon) untouched.
//
// Usage: node scripts/proof-phase6-console-e2e.mjs   (build first)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7931;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-console-e2e-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");
const readJsonl = (p) => { try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

function req(path, { method = "POST", body = null, headers = {} } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ } res({ status: resp.statusCode, json: j, text }); }); });
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

// ---- fixture root: PIN + one pending proposal + one halted workflow ----
fs.mkdirSync(join(ROOT, "config"), { recursive: true });
fs.writeFileSync(join(ROOT, "config", "settings.json"), JSON.stringify({ operatorPinHash: hashPin("1234"), requirePin: true }, null, 2), "utf8");
fs.mkdirSync(join(ROOT, "state", "proposals", "pending"), { recursive: true });
fs.mkdirSync(join(ROOT, "state", "proposals", "decided"), { recursive: true });
fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
fs.writeFileSync(join(ROOT, "state", "proposals", "pending", "p_e2e.json"), JSON.stringify({
  id: "p_e2e", at: new Date().toISOString(), type: "draft_document",
  title: "console e2e — draft a note", rationale: "fixture", reasoning: ["workspace_context"],
  confidence: null, predictionClaimId: null, predictedAsk: null,
  action: { toolId: "doc_generate", params: { title: "console-e2e-note", content: "approved via the console button", format: "md" } },
  status: "pending", decidedAt: null, result: null,
}, null, 2), "utf8");
fs.writeFileSync(join(ROOT, "workspace", "wf-del.txt"), "delete me via the console", "utf8");
fs.mkdirSync(join(ROOT, "state", "workflows"), { recursive: true });
fs.writeFileSync(join(ROOT, "state", "workflows", "wf_e2e.json"), JSON.stringify({
  id: "wf_e2e", title: "console e2e — halted delete chain", at: new Date().toISOString(),
  steps: [
    { toolId: "file_ops", params: { operation: "read", path: "workspace/wf-del.txt" }, description: "read" },
    { toolId: "file_ops", params: { operation: "delete", path: "workspace/wf-del.txt" }, description: "delete" },
  ],
  results: [{ ok: true, toolId: "file_ops", summary: "read workspace/wf-del.txt" }, null],
  cursor: 1, status: "halted_approval",
  halted: { toolId: "file_ops", resolvedParams: { operation: "delete", path: "workspace/wf-del.txt" }, reason: "step 2/2 requires operator approval" },
  updatedAt: new Date().toISOString(), error: null,
}, null, 2), "utf8");

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const token = v.json?.token;
  if (!token) throw new Error("no session token");
  const bearer = { authorization: `Bearer ${token}` };

  console.log("=== Button wiring: GET surfaces the console reads (gated) ===");
  const propGet = await req("/api/proposals", { method: "GET", headers: bearer });
  check("console proposals fetch returns the pending item", (propGet.json?.pending ?? []).some((p) => p.id === "p_e2e"));
  const wfGet = await req("/api/workflows", { method: "GET", headers: bearer });
  check("console workflows fetch returns the halted chain", (wfGet.json?.workflows ?? []).some((w) => w.id === "wf_e2e" && w.status === "halted_approval"));
  // Without a session the panels render the "operator session required" notice:
  const propUngated = await req("/api/proposals", { method: "GET" });
  check("ungated console fetch → 401 (panel shows notice)", propUngated.status === 401);

  console.log("\n=== Proposal Approve button → POST /api/proposals/decide ===");
  const pa = await req("/api/proposals/decide", { headers: bearer, body: { proposalId: "p_e2e", decision: "approve" } });
  check("approve click executes the proposal", pa.status === 200 && pa.json?.proposal?.status === "executed", `(status=${pa.json?.proposal?.status})`);
  const outDocs = fs.existsSync(join(ROOT, "output")) ? fs.readdirSync(join(ROOT, "output")) : [];
  check("approved doc written to disk", outDocs.some((n) => /console-e2e-note/.test(n)), `(${outDocs.join(", ")})`);

  console.log("\n=== Workflow Approve-step button → POST /api/workflows/decide ===");
  const wa = await req("/api/workflows/decide", { headers: bearer, body: { workflowId: "wf_e2e", decision: "approve" } });
  check("approve-step click completes the chain", wa.status === 200 && wa.json?.workflow?.status === "completed", `(status=${wa.json?.workflow?.status})`);
  check("approved delete executed (target gone)", !fs.existsSync(join(ROOT, "workspace", "wf-del.txt")));

  console.log("\n=== audit trail for the console decisions ===");
  await new Promise((r) => setTimeout(r, 300));
  const chain = readJsonl(join(ROOT, "state", "audit", "chain.jsonl"));
  check("proposal.applied audited", chain.some((e) => e.kind === "proposal.applied" && e.payload?.ok === true));
  check("workflow.step approvedByOperator audited", chain.some((e) => e.kind === "workflow.step" && e.payload?.approvedByOperator === true));
  check("workflow.completed audited", chain.some((e) => e.kind === "workflow.completed"));
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase6-console-e2e: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
