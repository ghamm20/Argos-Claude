#!/usr/bin/env node
// proof-dashboard.mjs (Stage 6, 2026-06-09) — verify the progression dashboard
// API: every live tile is present, carries a `source`, and exposes a real
// number/value; stubs are labeled and not faked as live.
//
// Usage: node scripts/proof-dashboard.mjs [--port 7897]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7897;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-dashboard-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function getJson(path) {
  return new Promise((res) => { http.get(new URL(path, BASE), (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }).on("error", () => res(null)); });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); }
  return false;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-dashboard\n");
  const d = await getJson("/api/dashboard");
  check("dashboard responded", !!d?.tiles);

  console.log("\n=== live tiles (each must carry a source + a real value) ===");
  const expectTiles = ["argos", "integrity", "toolStack", "inference", "agenticTools", "mirrors"];
  for (const name of expectTiles) {
    const tile = d.tiles?.[name];
    const hasSource = typeof tile?.source === "string" && tile.source.length > 0;
    const keys = tile ? Object.keys(tile).filter((k) => k !== "live" && k !== "source") : [];
    check(`tile '${name}' present, live, with source + ${keys.length} fields`, !!tile && tile.live === true && hasSource && keys.length > 0);
    if (tile) console.log(`        source: ${tile.source}`);
  }

  console.log("\n=== specific live numbers are traceable ===");
  check("argos.version present", typeof d.tiles.argos.version === "string", d.tiles.argos.version);
  check("integrity.runs is a number (from metrics log)", typeof d.tiles.integrity.runs === "number", `runs=${d.tiles.integrity.runs}`);
  check("toolStack.toolModel present", typeof d.tiles.toolStack.toolModel === "string", d.tiles.toolStack.toolModel);
  check("inference has per-persona policy", typeof d.tiles.inference.cloudDataPolicy === "object");
  check("agenticTools.email_read status is honest (dormant w/o token)", String(d.tiles.agenticTools.email_read.status).includes("dormant"), d.tiles.agenticTools.email_read.status);
  check("mirrors.parity reported", typeof d.tiles.mirrors.parity === "string", d.tiles.mirrors.parity);

  console.log("\n=== stubs are labeled, not faked live ===");
  check("3 stubs present", Array.isArray(d.stubs) && d.stubs.length === 3, d.stubs?.map((s) => s.name).join(", "));
  check("every stub marked kind=stub", d.stubs?.every((s) => s.kind === "stub"));
  check("no stub claims live=true", d.stubs?.every((s) => s.live !== true));
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-dashboard: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
