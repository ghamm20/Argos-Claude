#!/usr/bin/env node
// proof-r1-settings-guard.mjs — Phase 7 R1(b) (owner ruling, 2026-06-10).
//
// requirePin=true with NO operatorPinHash configured is an unreachable-
// operator state (every chat forced to guest). writeSettings() now REJECTS
// it; /api/settings surfaces a clean 400 (never a 500). Proof:
//   a. requirePin=true + no PIN on a fresh root → 400 with the explanatory error
//   b. PIN + requirePin together → 200 (the legitimate enable path)
//   c. requirePin=false (no PIN) → 200 (the legitimate disable path)
//   d. toggle requirePin=true again with the PIN already set → 200
//   e. clear PIN + requirePin=false together → 200
//
// R1-compliant: never touches Ollama.
// Usage: node scripts/proof-r1-settings-guard.mjs   (build first)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7936;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-r1-guard-${process.pid}`);
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function req(path, body) {
  return new Promise((res) => {
    const payload = Buffer.from(JSON.stringify(body));
    const u = new URL(path, BASE);
    const r = http.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", "content-length": payload.length }, timeout: 20000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { const t = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(t); } catch { /* */ } res({ status: resp.statusCode, json: j }); }); });
    r.on("error", () => res({ status: 0, json: null })); r.on("timeout", () => { r.destroy(); res({ status: 0, json: null }); });
    r.write(payload); r.end();
  });
}
async function ready(maxSec = 60) { for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false; }

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");

  console.log("=== a. requirePin=true with NO PIN → 400 (unreachable-operator rejected) ===");
  const a = await req("/api/settings", { requirePin: true });
  check("rejected with 400", a.status === 400, `(status=${a.status})`);
  check("error explains the unreachable-operator state", /unreachable-operator|requires an operatorPinHash/i.test(a.json?.error ?? ""), a.json?.error);

  console.log("\n=== b. PIN + requirePin together → 200 (legit enable) ===");
  const b = await req("/api/settings", { operatorPinHash: hashPin("1234"), requirePin: true });
  check("accepted 200", b.status === 200 && b.json?.requirePin === true);

  console.log("\n=== c/d/e. legit toggles all 200 ===");
  const d = await req("/api/settings", { requirePin: true }); // PIN already set
  check("d: requirePin=true with PIN already set → 200", d.status === 200);
  const e = await req("/api/settings", { operatorPinHash: null, requirePin: false });
  check("e: clear PIN + requirePin=false together → 200", e.status === 200 && e.json?.requirePin === false && e.json?.operatorPinHash === null);
  const c = await req("/api/settings", { requirePin: false });
  check("c: requirePin=false with no PIN → 200", c.status === 200);

  console.log("\n=== regression: a NON-auth settings field still saves ===");
  const f = await req("/api/settings", { useReboundModels: true });
  check("unrelated field saves 200", f.status === 200 && f.json?.useReboundModels === true);

  console.log("\n=== g. PRE-EXISTING bad state on disk must NOT block unrelated writes ===");
  // Plant the unreachable-operator state directly on disk (as a real deploy
  // config can already be), then prove an unrelated write still succeeds — the
  // guard stops CREATING the bad state, it must not brick editing around one.
  fs.writeFileSync(join(ROOT, "config", "settings.json"), JSON.stringify({ version: 1, requirePin: true, updatedAt: 1 }, null, 2), "utf8");
  const g1 = await req("/api/settings", { defaultPersona: "juniper" });
  check("g1: unrelated write (defaultPersona) on pre-existing bad state → 200", g1.status === 200 && g1.json?.defaultPersona === "juniper");
  // But re-asserting the bad state via an auth field is still blocked.
  const g2 = await req("/api/settings", { requirePin: true });
  check("g2: re-asserting requirePin=true (still no PIN) → 400", g2.status === 400);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-r1-settings-guard: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
