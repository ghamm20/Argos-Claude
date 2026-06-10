#!/usr/bin/env node
// proof-concurrency.mjs (G3, 2026-06-09) — prove VRAM-aware concurrency.
//   Run 1 (LEAN, real 3060 Ti): policy = serialize (one model resident, swap as
//     needed) = today's behavior, byte-for-byte. gpu.concurrency_policy audited.
//   Run 2 (FORCED ample 24GB): policy COMPUTES a resident set (tool + conv +
//     judge) sized to fit VRAM minus the reserve — computed, not executed.
//     gpu.concurrency_policy audited; the set respects the headroom budget.
//
// Usage: node scripts/proof-concurrency.mjs [--port 7900]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7900;

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function getJson(base, path) { return new Promise((res) => { http.get(new URL(path, base), (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }).on("error", () => res(null)); }); }
async function ready(base, maxSec = 60) { for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false; }
function audit(root, kind) { try { return fs.readFileSync(join(root, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } }
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

const ROOT1 = join(tmpdir(), `argos-conc-lean-${process.pid}`);
const ROOT2 = join(tmpdir(), `argos-conc-ample-${process.pid}`);

try {
  console.log("=== Run 1: LEAN (real 3060 Ti) — policy must be serialize (unchanged) ===");
  const s1 = await runServer(PORT, ROOT1, {});
  const g1 = await getJson(s1.base, "/api/gpu");
  console.log(`  policy: ${JSON.stringify(g1?.concurrency)}`);
  check("lean → mode 'serialize'", g1?.concurrency?.mode === "serialize", g1?.concurrency?.mode);
  check("serialize holds exactly ONE model resident", (g1?.concurrency?.resident?.length ?? 0) === 1);
  await new Promise((r) => setTimeout(r, 200));
  check("gpu.concurrency_policy audited (lean/serialize)", audit(ROOT1, "gpu.concurrency_policy").some((e) => e.payload?.mode === "serialize"));
  kill(s1.server);

  console.log("\n=== Run 2: FORCED ample (5090/24GB) — computes a headroom-bound resident set ===");
  const s2 = await runServer(PORT + 1, ROOT2, { ARGOS_FORCE_GPU_PROFILE: "NVIDIA RTX 5090,24576" });
  const g2 = await getJson(s2.base, "/api/gpu");
  const pol = g2?.concurrency;
  console.log(`  policy: ${JSON.stringify(pol)}`);
  check("ample → resident-set computed", pol?.mode === "resident-set", pol?.mode);
  check("resident set has 2+ models (no-swap)", (pol?.resident?.length ?? 0) >= 2, `${pol?.resident?.length} models`);
  const budget = (pol?.vramMb ?? 0) - (pol?.reserveMb ?? 0);
  check("resident set fits within VRAM minus reserve (no OOM)", pol?.totalResidentMb <= budget && pol?.fits === true, `total=${pol?.totalResidentMb} budget=${budget}`);
  await new Promise((r) => setTimeout(r, 200));
  check("gpu.concurrency_policy audited (ample/resident-set)", audit(ROOT2, "gpu.concurrency_policy").some((e) => e.payload?.mode === "resident-set"));
  kill(s2.server);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { fs.rmSync(ROOT1, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-concurrency: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
