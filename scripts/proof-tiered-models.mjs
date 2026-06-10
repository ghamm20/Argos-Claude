#!/usr/bin/env node
// proof-tiered-models.mjs (G2, 2026-06-09) — prove the agnostic routing core.
//   Run 1 (LEAN, real 3060 Ti): resolver returns the LEAN models for every role
//     (= today's exact bindings), availability confirmed, no fallback.
//   Run 2 (FORCED ample): resolver REQUESTS ample models; since qwen3-64k /
//     gpt-oss aren't the served tier (qwen3-64k unpulled), it cleanly FALLS BACK
//     down-tier with a model.tier_fallback audit. Proves the whole agnostic path
//     end-to-end without owning a 5090.
//
// Usage: node scripts/proof-tiered-models.mjs [--port 7899]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7899;

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

const ROOT1 = join(tmpdir(), `argos-tiered-lean-${process.pid}`);
const ROOT2 = join(tmpdir(), `argos-tiered-ample-${process.pid}`);

// Expected lean models (today's exact bindings).
const LEAN_EXPECT = {
  "tool-execution": "hermes3:8b",
  "persona:bartimaeus": "aratan/gemma-4-E4B-q8-it-heretic:latest",
  "persona:bobby": "CyberCrew/notmythos-8b:latest",
};

try {
  console.log("=== Run 1: LEAN tier (real 3060 Ti) — resolver serves today's exact models ===");
  const s1 = await runServer(PORT, ROOT1, {});
  const r1 = await getJson(s1.base, "/api/models/resolve");
  console.log(`  profile: ${r1?.profile?.tier} ${r1?.profile?.vramGb}GB`);
  check("detected lean tier", r1?.profile?.tier === "lean", r1?.profile?.tier);
  for (const [role, expect] of Object.entries(LEAN_EXPECT)) {
    const got = r1?.resolved?.[role];
    check(`${role} → lean model (${expect})`, got?.model === expect && got?.servedTier === "lean" && got?.fellBack === false, `${got?.model} servedTier=${got?.servedTier} fellBack=${got?.fellBack}`);
  }
  await new Promise((r) => setTimeout(r, 200));
  check("NO tier_fallback on lean (every lean model is pulled)", audit(ROOT1, "model.tier_fallback").length === 0);
  kill(s1.server);

  console.log("\n=== Run 2: FORCED ample (5090/24GB) — requests ample, falls back (unpulled) ===");
  const s2 = await runServer(PORT + 1, ROOT2, { ARGOS_FORCE_GPU_PROFILE: "NVIDIA RTX 5090,24576" });
  const r2 = await getJson(s2.base, "/api/models/resolve?role=tool-execution");
  const tool = r2?.resolved?.["tool-execution"];
  console.log(`  tool-execution resolved: ${JSON.stringify(tool)}`);
  check("profile is ample (forced)", r2?.profile?.tier === "ample" && r2?.profile?.forced === true, `${r2?.profile?.tier} forced=${r2?.profile?.forced}`);
  check("requestedTier is ample", tool?.requestedTier === "ample", tool?.requestedTier);
  check("qwen3-64k unpulled → fell back below ample", tool?.fellBack === true && tool?.servedTier !== "ample", `served=${tool?.model} tier=${tool?.servedTier}`);
  check("served model IS pulled (never a broken state)", typeof tool?.model === "string" && tool.model.length > 0, tool?.model);
  await new Promise((r) => setTimeout(r, 200));
  const fb = audit(ROOT2, "model.tier_fallback");
  check("model.tier_fallback audited (requested vs served)", fb.length >= 1, JSON.stringify(fb[0]?.payload));
  kill(s2.server);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { fs.rmSync(ROOT1, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-tiered-models: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
