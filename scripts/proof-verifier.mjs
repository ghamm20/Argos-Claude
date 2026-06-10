#!/usr/bin/env node
// proof-verifier.mjs (Stage 9, 2026-06-09) — the Judge pass / verifier primitive.
//   1. A night cycle emits Claims for its actions; the Judge VERIFIES the real
//      ones mechanically (pdf moved → file_exists; proposed task → task_status).
//   2. SEEDED FALSE CLAIM: a synthetic tool result claiming a write that did NOT
//      happen → the Judge MUST catch it (verdict: failed).
//   3. Operator OVERRIDE grade appends to the verifier chain.
//
// Usage: node scripts/proof-verifier.mjs [--port 7903]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7903;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-verifier-${process.pid}`);
const FIXTURES = join(ROOT, "fixtures.json");
const YEAR = String(new Date().getUTCFullYear());

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
function reqJson(method, path, body) { return new Promise((res) => { const p = body ? Buffer.from(JSON.stringify(body)) : null; const u = new URL(path, BASE); const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", ...(p ? { "content-length": p.length } : {}) }, timeout: 60000 }, (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }); r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); if (p) r.write(p); r.end(); }); }
async function ready(maxSec = 60) { for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false; }
function audit(kind) { try { return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } }

fs.mkdirSync(join(ROOT, "workspace", "inbox"), { recursive: true });
fs.mkdirSync(join(ROOT, "state"), { recursive: true });
fs.writeFileSync(join(ROOT, "workspace", "inbox", "report1.pdf"), "PDF", "utf8");
fs.writeFileSync(join(ROOT, "state", "night-rules.json"), JSON.stringify({ rules: [{ id: "pdf-archive", match: "workspace/inbox/*.pdf", action: "move", destTemplate: "workspace/reports/{year}/", autoApprove: true }] }), "utf8");
fs.writeFileSync(FIXTURES, JSON.stringify([{ id: "m1", from: "client@ekg.test", subject: "URGENT: please sign the contract", snippet: "sign", body: "Please sign ASAP." }]), "utf8");

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT, ARGOS_EMAIL_FIXTURES: FIXTURES }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-verifier\n");

  console.log("=== night cycle emits claims; Judge verifies the REAL ones ===");
  const nc = await reqJson("POST", "/api/night", { skipIntegrity: true });
  const v = nc?.verification;
  console.log(`  verification: ${JSON.stringify(v && { total: v.total, verified: v.verified, failed: v.failed })}`);
  check("claims were emitted + judged", (v?.total ?? 0) >= 2, `total=${v?.total}`);
  check("the file-move claim VERIFIED mechanically (file_exists)", v?.outcomes?.some((o) => /report1\.pdf/.test(o.assertion) && o.verdict === "verified"));
  check("the proposed-task claim VERIFIED (task_status)", v?.outcomes?.some((o) => /proposed task/.test(o.assertion) && o.verdict === "verified"));
  check("NO false failures on honest actions", (v?.failed ?? 1) === 0, `failed=${v?.failed}`);
  check("brief has a Verification section", fs.readFileSync(nc.briefPath, "utf8").includes("## Verification"));

  console.log("\n=== SEEDED FALSE CLAIM — Judge MUST catch a write that didn't happen ===");
  const seeded = await reqJson("POST", "/api/verifier", { judge: { source: "adversarial", assertion: "wrote workspace/reports/ghost.txt", check: { type: "file_exists", path: "workspace/reports/ghost.txt" } } });
  console.log(`  outcome: ${JSON.stringify(seeded?.outcome)}`);
  check("Judge CAUGHT the false claim (verdict: failed)", seeded?.outcome?.verdict === "failed", seeded?.outcome?.verdict);
  check("caught mechanically (un-foolable)", seeded?.outcome?.method === "mechanical");
  check("verifier.outcome hash-chained in the audit", audit("verifier.outcome").some((e) => e.payload?.verdict === "failed"));

  console.log("\n=== operator OVERRIDE grade appends to the verifier chain ===");
  const ov = await reqJson("POST", "/api/verifier", { override: { claimId: seeded.claim.id, grade: "wrong", note: "confirmed fabricated" } });
  check("override recorded", ov?.override?.grade === "wrong");
  check("verifier.override hash-chained", audit("verifier.override").length >= 1);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-verifier: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
