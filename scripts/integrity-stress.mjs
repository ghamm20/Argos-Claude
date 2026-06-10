#!/usr/bin/env node
// integrity-stress.mjs (Stage 5 / v2.4.3, 2026-06-09) — run the adversarial
// integrity corpus against the live stack (the REAL guards via the in-process
// runner behind /api/integrity/stress) and print the per-case table. A
// guard-MISS is listed individually with evidence — a finding, never summarized
// away. Appends results to state/integrity-metrics.jsonl (server-side).
//
// Usage: node scripts/integrity-stress.mjs [--port 7896]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7896;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-integrity-stress-${process.pid}`);

const commit = (() => {
  try { return spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() || "unknown"; }
  catch { return "unknown"; }
})();

function post(path, body) {
  return new Promise((res) => {
    const payload = Buffer.from(JSON.stringify(body));
    const u = new URL(path, BASE);
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", "content-length": payload.length }, timeout: 30000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
    r.write(payload); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(
  process.execPath,
  [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
);
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

let exitCode = 1;
try {
  if (!(await ready())) throw new Error("server not ready");
  console.log(`[integrity-stress] commit ${commit}\n`);
  const r = await post("/api/integrity/stress", { commit });
  if (!r) throw new Error("stress run returned nothing");

  console.log(`=== per-case results (${r.total} cases: ${r.positives} positive, ${r.controls} control) ===`);
  for (const c of r.cases) {
    const mark = c.outcome === "caught" || c.outcome === "correct_pass" ? "ok " : "!! ";
    const fired = Object.entries(c.fired).filter(([, v]) => v).map(([k]) => k).join(",") || "none";
    console.log(`  [${mark}] ${c.id.padEnd(20)} ${c.category.padEnd(30)} expect=${c.expectedGuard.padEnd(20)} outcome=${c.outcome.padEnd(14)} fired=${fired}`);
  }

  console.log("\n=== rolling metrics for THIS run ===");
  console.log(`  catch rate:           ${(r.catchRate * 100).toFixed(1)}%  (${r.caught}/${r.positives} positives caught)`);
  console.log(`  miss rate:            ${(r.missRate * 100).toFixed(1)}%  (${r.missed} missed)`);
  console.log(`  false-positive rate:  ${(r.falsePositiveRate * 100).toFixed(1)}%  (${r.falsePositives}/${r.controls} controls)`);
  console.log("  per-guard:");
  for (const [g, v] of Object.entries(r.byGuard)) console.log(`    ${g.padEnd(22)} ${v.caught}/${v.total}`);

  if (r.findings.length > 0) {
    console.log("\n=== FINDINGS (misses + false positives — individually, with evidence) ===");
    for (const f of r.findings) {
      console.log(`  ${f.id} [${f.category}] outcome=${f.outcome} expected=${f.expectedGuard} fired=${JSON.stringify(f.fired)}`);
    }
  } else {
    console.log("\n  no findings — every positive caught, no control false-fired.");
  }

  // Per the directive: misses are FINDINGS, not blockers — the run continues
  // and reports them (above, individually, with evidence + the metrics log + the
  // HUD red-flag). The GATE fails only on a provable guard COLLAPSE: catch rate
  // below 0.6, or controls false-firing pervasively (>30%). 83% with named gaps
  // is the honest measured baseline, not a collapse.
  const collapsed = r.catchRate < 0.6 || r.falsePositiveRate > 0.3;
  console.log(`\nintegrity-stress: catchRate=${(r.catchRate * 100).toFixed(1)}% fp=${(r.falsePositiveRate * 100).toFixed(1)}% findings=${r.findings.length} — ${collapsed ? "COLLAPSE (halt)" : "BASELINE OK (findings reported)"}`);
  exitCode = collapsed ? 1 : 0;
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(exitCode);
