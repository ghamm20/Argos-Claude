#!/usr/bin/env node
// proof-phase1.mjs (Phase 1, 2026-06-10) — file_ops under the locked governance
// tiers. Gates:
//   1. E2E: an OPERATOR-session persona reads a status report (low-friction) and
//      SAVES a summary file (write = SESSION-GATED — auto-executes, no approval
//      pause), with audit-chain entries for both.
//   2. Junction-escape attempt is BLOCKED + logged.
//   3. DELETE lands in the approval queue and does NOT execute (file survives).
//   4. Read past the truncation cap truncates cleanly.
//
// Usage: node scripts/proof-phase1.mjs [--port 7910]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7910;
const BASE = `http://127.0.0.1:${PORT}`;
const base2 = join(tmpdir(), `argos-phase1-${process.pid}`);
const ROOT = join(base2, "root");
const OUTSIDE = join(base2, "outside");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
// /api/tools/execute returns PLAIN JSON (not a stream) — read the whole body.
function reqJson(method, path, body) { return new Promise((res) => { const p = body ? Buffer.from(JSON.stringify(body)) : null; const u = new URL(path, BASE); const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", ...(p ? { "content-length": p.length } : {}) }, timeout: 120000 }, (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }); r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); if (p) r.write(p); r.end(); }); }
async function ready(maxSec = 60) { for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false; }
function toolAudit() { try { return fs.readFileSync(join(ROOT, "state", "tool-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }

// ---- setup ----
fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(join(ROOT, "workspace", "status-report.txt"), "All services nominal. Vault 19 docs. No incidents in 24h.", "utf8");
fs.writeFileSync(join(OUTSIDE, "secret.txt"), "OUTSIDE_SECRET", "utf8");
fs.writeFileSync(join(ROOT, "workspace", "big.txt"), "x".repeat(25000), "utf8"); // > 20k cap
fs.writeFileSync(join(ROOT, "workspace", "to-keep.txt"), "must survive a queued delete", "utf8");
// junction inside root → outside
const linkPath = join(ROOT, "workspace", "escape");
let junctionMade = false;
try { const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, OUTSIDE], { encoding: "utf8" }); junctionMade = r.status === 0 && fs.existsSync(linkPath); } catch { /* */ }

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const exec = (params) => reqJson("POST", "/api/tools/execute", { toolId: "file_ops", params, personaId: "bartimaeus" });

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-phase1\n");

  console.log("=== Gate 1: read (low-friction) + write summary (SESSION-GATED, auto-executes) ===");
  const rd = await exec({ operation: "read", path: "workspace/status-report.txt" });
  check("read is low-friction (ran, returned content)", rd?.ok === true && /nominal/.test(JSON.stringify(rd?.result?.data ?? "")));
  const wr = await exec({ operation: "write", path: "workspace/summary.md", content: "Summary: all services nominal; no incidents in the last 24h. No action required." });
  check("write is SESSION-GATED (auto-executed, NO approval pause)", wr?.ok === true && !wr?.approvalRequired);
  check("summary.md saved on disk", fs.existsSync(join(ROOT, "workspace", "summary.md")));
  await new Promise((r) => setTimeout(r, 200));
  const ta = toolAudit();
  check("audit chain has read + write entries", ta.some((e) => e.toolId === "file_ops" && /read/.test(e.summary)) && ta.some((e) => e.toolId === "file_ops" && /wrote/.test(e.summary)),
    `audit entries: ${ta.filter((e) => e.toolId === "file_ops").length}`);

  console.log("\n=== Gate 2: junction-escape BLOCKED + logged ===");
  if (!junctionMade) check("junction-escape (SKIP — could not create junction)", true, "non-NTFS/restricted");
  else {
    const esc = await exec({ operation: "read", path: "workspace/escape/secret.txt" });
    check("junction-escape read REJECTED", esc?.ok === false && /boundary|symlink/.test(esc?.result?.error ?? ""), esc?.result?.error);
    check("no OUTSIDE content leaked", !JSON.stringify(esc ?? {}).includes("OUTSIDE_SECRET"));
    check("rejection audit-logged", toolAudit().some((e) => e.toolId === "file_ops" && /boundary|symlink/.test(e.error ?? "")));
  }

  console.log("\n=== Gate 3: DELETE → approval queue, does NOT execute ===");
  const del = await exec({ operation: "delete", path: "workspace/to-keep.txt" });
  check("delete requires APPROVAL (queued, not run)", del?.approvalRequired === true, `approvalRequired=${del?.approvalRequired}`);
  check("target file SURVIVES (delete did not execute)", fs.existsSync(join(ROOT, "workspace", "to-keep.txt")));

  console.log("\n=== Gate 4: read past truncation cap truncates cleanly ===");
  const big = await exec({ operation: "read", path: "workspace/big.txt" });
  const data = big?.result?.data ?? {};
  check("oversized read truncated (truncated flag + capped length)", data.truncated === true && (data.content?.length ?? 0) <= 20000, `len=${data.content?.length} truncated=${data.truncated}`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { spawnSync("cmd", ["/c", "rmdir", linkPath]); } catch { /* */ }
  try { fs.rmSync(base2, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase1: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
