#!/usr/bin/env node
// proof-power-mode.mjs (G4, 2026-06-09) — prove Power Mode gating + parallel
// persona reasoning (council).
//   Run 1 (LEAN, real 3060 Ti): Power Mode UNAVAILABLE with the honest reason;
//     /api/council REFUSES (available:false) — no parallel run on 8GB.
//     gpu.power_mode_available audited (available:false).
//   Run 2 (FORCED ample 24GB, stub generation): Power Mode AVAILABLE; council
//     DISPATCHES all members CONCURRENTLY (stub, no real inference / no thrash),
//     power_mode.council_run audited. No hardware faked — the GPU override is
//     audited as forced; the council uses a deterministic stub.
//
// Usage: node scripts/proof-power-mode.mjs [--port 7901]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7901;

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function reqJson(base, method, path, body) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, base);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", ...(payload ? { "content-length": payload.length } : {}) }, timeout: 30000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
    if (payload) r.write(payload); r.end();
  });
}
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

const ROOT1 = join(tmpdir(), `argos-power-lean-${process.pid}`);
const ROOT2 = join(tmpdir(), `argos-power-ample-${process.pid}`);

try {
  console.log("=== Run 1: LEAN (real 3060 Ti) — Power Mode unavailable, council refuses ===");
  const s1 = await runServer(PORT, ROOT1, {});
  const p1 = await reqJson(s1.base, "GET", "/api/power");
  console.log(`  status: ${JSON.stringify(p1)}`);
  check("Power Mode UNAVAILABLE on lean", p1?.available === false, `available=${p1?.available}`);
  check("honest reason names detected tier", /requires ample-tier/.test(p1?.reason ?? ""), p1?.reason);
  const c1 = await reqJson(s1.base, "POST", "/api/council", { query: "Assess the deployment risk." });
  check("council REFUSES on lean (no 8GB thrash)", c1?.available === false && (c1?.members?.length ?? 0) === 0, `available=${c1?.available}`);
  await new Promise((r) => setTimeout(r, 200));
  check("gpu.power_mode_available audited (false)", audit(ROOT1, "gpu.power_mode_available").some((e) => e.payload?.available === false));
  kill(s1.server);

  console.log("\n=== Run 2: FORCED ample (5090/24GB, stub gen) — available + concurrent council ===");
  const s2 = await runServer(PORT + 1, ROOT2, { ARGOS_FORCE_GPU_PROFILE: "NVIDIA RTX 5090,24576", ARGOS_COUNCIL_STUB: "1" });
  const p2 = await reqJson(s2.base, "GET", "/api/power");
  check("Power Mode AVAILABLE on ample", p2?.available === true, `available=${p2?.available}`);
  check("status lists what it enables", Array.isArray(p2?.enables) && p2.enables.length >= 4, `${p2?.enables?.length} enables`);
  const c2 = await reqJson(s2.base, "POST", "/api/council", { query: "Assess the deployment risk.", personas: ["bartimaeus", "sage", "bobby"] });
  console.log(`  council: ${c2?.members?.length} members, ${c2?.durationMs}ms`);
  check("council DISPATCHED (available true)", c2?.available === true);
  check("all 3 members returned a result", (c2?.members?.length ?? 0) === 3 && c2.members.every((m) => m.ok), JSON.stringify(c2?.members?.map((m) => `${m.persona}:${m.model}`)));
  await new Promise((r) => setTimeout(r, 200));
  check("power_mode.council_run audited", audit(ROOT2, "power_mode.council_run").length >= 1, JSON.stringify(audit(ROOT2, "power_mode.council_run")[0]?.payload?.personas));
  kill(s2.server);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { fs.rmSync(ROOT1, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-power-mode: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
