#!/usr/bin/env node
// proof-gpu-detect.mjs (G1, 2026-06-09) — prove GPU detection + tier logic.
//   Run 1 (REAL): live hardware → tier reflects the actual card (lean on the
//                 3060 Ti / 8GB), gpu.profile_detected audited.
//   Run 2 (FORCED): ARGOS_FORCE_GPU_PROFILE="NVIDIA RTX 5090,24576" → tier
//                 logic selects "ample" at >20GB (test-only, NO hardware faked),
//                 gpu.profile_forced audited AND the real gpu.profile_detected
//                 STILL fired (the audit reflects true hardware + the override).
//
// Usage: node scripts/proof-gpu-detect.mjs [--port 7898]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7898;

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function getJson(base, path) {
  return new Promise((res) => { http.get(new URL(path, base), (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }).on("error", () => res(null)); });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); }
  return false;
}
function audit(root, kind) {
  try { return fs.readFileSync(join(root, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; }
}

async function runServer(port, root, env) {
  fs.mkdirSync(root, { recursive: true });
  const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: root, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  if (!(await ready(base))) { server.kill("SIGKILL"); throw new Error("server not ready"); }
  return { server, base };
}
function kill(server) { try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ } }

const ROOT1 = join(tmpdir(), `argos-gpu-real-${process.pid}`);
const ROOT2 = join(tmpdir(), `argos-gpu-forced-${process.pid}`);

try {
  console.log("=== Run 1: REAL detection (live hardware) ===");
  const s1 = await runServer(PORT, ROOT1, {});
  const g1 = await getJson(s1.base, "/api/gpu");
  console.log(`  detected: ${JSON.stringify(g1)}`);
  check("real profile not forced", g1 && g1.forced === false, `forced=${g1?.forced}`);
  check("real source is hardware (nvidia-smi via detectHardware)", g1?.source === "hardware", g1?.source);
  check("3060 Ti / 8GB → tier 'lean'", g1?.tier === "lean" && g1?.vramGb <= 9, `tier=${g1?.tier} vram=${g1?.vramGb}GB`);
  await new Promise((r) => setTimeout(r, 300));
  check("gpu.profile_detected audit written (REAL hardware)", audit(ROOT1, "gpu.profile_detected").length >= 1, JSON.stringify(audit(ROOT1, "gpu.profile_detected")[0]?.payload));
  kill(s1.server);

  console.log("\n=== Run 2: FORCED ample profile (test override, NO hardware faked) ===");
  const s2 = await runServer(PORT + 1, ROOT2, { ARGOS_FORCE_GPU_PROFILE: "NVIDIA RTX 5090,24576" });
  const g2 = await getJson(s2.base, "/api/gpu");
  console.log(`  effective: ${JSON.stringify(g2)}`);
  check("forced profile tier logic selects 'ample' at 24GB", g2?.tier === "ample", `tier=${g2?.tier}`);
  check("forced flag is true (override, not real)", g2?.forced === true);
  await new Promise((r) => setTimeout(r, 300));
  check("gpu.profile_forced audit written (override visible)", audit(ROOT2, "gpu.profile_forced").length >= 1);
  check("REAL gpu.profile_detected ALSO fired (audit reflects true hardware)", audit(ROOT2, "gpu.profile_detected").length >= 1,
    `real card audited: ${audit(ROOT2, "gpu.profile_detected")[0]?.payload?.name} ${audit(ROOT2, "gpu.profile_detected")[0]?.payload?.tier}`);
  kill(s2.server);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { fs.rmSync(ROOT1, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-gpu-detect: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
