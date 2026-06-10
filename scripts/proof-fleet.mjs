#!/usr/bin/env node
// proof-fleet.mjs (Stage 10, 2026-06-09) — remote-executor backend.
//   1. ROUND-TRIP: a fleet endpoint pointed at the LOCAL Ollama (loopback
//      stand-in for the remote rig) — dispatch a task, get a real model result
//      back THROUGH the ARGOS pipeline: fleet.dispatch audited + a Judge verdict.
//   2. DEFERRED: an unreachable endpoint (the Ubuntu rig isn't on the tailnet) →
//      clean deferral with a fleet_endpoint_deferred audit, NOT a swallowed
//      error. Proves the agnostic interface works without owning the rig.
//
// Judge runs in stub mode (ARGOS_JUDGE_STUB) for a deterministic verdict.
// Usage: node scripts/proof-fleet.mjs [--port 7904]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7904;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-fleet-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
function reqJson(method, path, body) { return new Promise((res) => { const p = body ? Buffer.from(JSON.stringify(body)) : null; const u = new URL(path, BASE); const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", ...(p ? { "content-length": p.length } : {}) }, timeout: 90000 }, (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }); r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); if (p) r.write(p); r.end(); }); }
async function ready(maxSec = 60) { for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false; }
function audit(kind) { try { return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } }

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT, ARGOS_JUDGE_STUB: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-fleet\n");

  // Configure two endpoints: a reachable loopback stand-in + an unreachable rig.
  await reqJson("POST", "/api/settings", { fleet: { endpoints: [
    { id: "loopback", baseUrl: "http://127.0.0.1:11434", policy: "redacted" },
    { id: "ubuntu-rig", baseUrl: "http://100.99.99.99:11434", policy: "redacted" },
  ] } });
  const ep = await reqJson("GET", "/api/fleet");
  console.log(`  endpoints: ${JSON.stringify(ep?.endpoints?.map((e) => ({ id: e.id, reachable: e.reachable, models: e.models?.length })))}`);
  check("loopback endpoint reachable", ep?.endpoints?.find((e) => e.id === "loopback")?.reachable === true);
  check("ubuntu-rig endpoint UNREACHABLE (not on tailnet)", ep?.endpoints?.find((e) => e.id === "ubuntu-rig")?.reachable === false);

  console.log("\n=== ROUND-TRIP: dispatch to the loopback stand-in (real model) ===");
  const rt = await reqJson("POST", "/api/fleet", { task: "In one short sentence, what is a load balancer?", endpointId: "loopback", model: "CyberCrew/notmythos-8b:latest" });
  console.log(`  result: ok=${rt?.ok} model=${rt?.model} chars=${rt?.content?.length} verdict=${rt?.verdict} ${rt?.latencyMs}ms`);
  check("dispatch returned a real non-empty result", rt?.ok === true && (rt?.content?.length ?? 0) > 0);
  check("fleet.dispatch audited", audit("fleet.dispatch").some((e) => e.payload?.ok === true));
  check("result carries a Judge verdict (returned THROUGH the pipeline)", typeof rt?.verdict === "string" && rt.verdict.length > 0, rt?.verdict);
  check("dispatch wrapped in a verifier claim", typeof rt?.claimId === "string" && rt.claimId.startsWith("c_"));

  console.log("\n=== DEFERRED: dispatch to the unreachable rig — clean deferral, not a swallowed error ===");
  const df = await reqJson("POST", "/api/fleet", { task: "draft something", endpointId: "ubuntu-rig" });
  console.log(`  result: ${JSON.stringify({ deferred: df?.deferred, reason: df?.reason })}`);
  check("dispatch DEFERRED (not errored)", df?.deferred === true && df?.ok === false);
  check("fleet_endpoint_deferred audited", audit("fleet_endpoint_deferred").some((e) => e.payload?.endpointId === "ubuntu-rig"));
  check("deferral reason names the unreachable endpoint", /unreachable/.test(df?.reason ?? ""), df?.reason);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-fleet: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
