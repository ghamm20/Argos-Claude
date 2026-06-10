#!/usr/bin/env node
// proof-phase7-power-override.mjs — Phase 7 capability-gating gates (2026-06-10).
//
//   Gate 1: on the REAL 3060 Ti, detection reports STANDARD (lean); Power Mode
//           UNAVAILABLE; gated features are listed (UI greys + labels them).
//   Gate 2: BOTH operator override paths work, and attempt-on FAILS CLEANLY:
//             - auto       → follows detection (unavailable on lean)
//             - force-off  → unavailable, operator-disabled reason
//             - attempt-on → HONEST failure with an explicit VRAM error, NOT a
//               fake success; gpu.power_override + gpu.power_attempt_failed
//               audited; the override persists (survives a re-read).
//           Rule 8: un-sessioned POST /api/power → 401 (override is gated).
//   Gate 3: POWER-tier path is mock-verified — a FORCED ample profile
//           (ARGOS_FORCE_GPU_PROFILE) makes Power Mode AVAILABLE and an
//           operator attempt-on SUCCEEDS in code (no real ≥24GB hardware).
//
// HONESTY: gate 3 uses a forced profile + is audited as forced. No claim of a
// working Power Mode on real hardware — that is the 5090-day checklist.
// R1-compliant: never touches Ollama.
//
// Usage: node scripts/proof-phase7-power-override.mjs   (build first)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const ROOT_LEAN = join(tmpdir(), `argos-p7-lean-${process.pid}`);
const ROOT_AMPLE = join(tmpdir(), `argos-p7-ample-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");
const audit = (root, kind) => { try { return fs.readFileSync(join(root, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };

function req(base, path, { method = "POST", body = null, headers = {} } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, base);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 30000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ } res({ status: resp.statusCode, json: j }); }); });
    r.on("error", () => res({ status: 0, json: null }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null }); });
    if (payload) r.write(payload); r.end();
  });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}
async function runServer(port, root, env) {
  fs.mkdirSync(join(root, "config"), { recursive: true });
  fs.writeFileSync(join(root, "config", "settings.json"), JSON.stringify({ operatorPinHash: hashPin("1234"), requirePin: true }, null, 2), "utf8");
  const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: root, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  if (!(await ready(base))) { server.kill("SIGKILL"); throw new Error("server not ready"); }
  return { server, base };
}
const kill = (s) => { try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(s.pid)]); else s.kill("SIGKILL"); } catch { /* */ } };
const token = async (base) => (await req(base, "/api/auth/verify", { body: { pinHash: hashPin("1234") } })).json?.token;

try {
  // ===== Gates 1 + 2: REAL lean 3060 Ti =====
  console.log("=== Gate 1: detection STANDARD on the real 3060 Ti ===");
  const s1 = await runServer(7933, ROOT_LEAN, {});
  const gpu = await req(s1.base, "/api/gpu", { method: "GET" });
  check("detection reports lean/STANDARD tier", gpu.json?.tier === "lean", `(tier=${gpu.json?.tier}, ${gpu.json?.vramGb}GB, name=${gpu.json?.name})`);
  const pwr = await req(s1.base, "/api/power", { method: "GET" });
  check("Power Mode UNAVAILABLE on lean", pwr.json?.available === false, `(available=${pwr.json?.available})`);
  check("honest reason names the detected tier", /requires.*ample|lean/i.test(pwr.json?.reason ?? ""), pwr.json?.reason);
  check("gated features are listed (UI greys + labels them)", Array.isArray(pwr.json?.enables) && pwr.json.enables.length >= 4, `(${pwr.json?.enables?.length} features)`);

  console.log("\n=== Gate 2: operator override paths (Rule 8 + honest attempt-on) ===");
  const ungated = await req(s1.base, "/api/power", { method: "POST", body: { mode: "attempt-on" } });
  check("un-sessioned POST /api/power → 401", ungated.status === 401, `(status=${ungated.status})`);
  const tok = await token(s1.base);
  const bearer = { authorization: `Bearer ${tok}` };

  const offRes = await req(s1.base, "/api/power", { method: "POST", headers: bearer, body: { mode: "force-off" } });
  check("force-off → unavailable, operator-disabled reason", offRes.json?.available === false && /force-OFF/i.test(offRes.json?.reason ?? ""), offRes.json?.reason);

  const onRes = await req(s1.base, "/api/power", { method: "POST", headers: bearer, body: { mode: "attempt-on" } });
  check("attempt-on FAILS (not a fake success)", onRes.json?.available === false && onRes.json?.attemptFailed === true, `(available=${onRes.json?.available}, attemptFailed=${onRes.json?.attemptFailed})`);
  check("attempt-on error is explicit about VRAM", /requires an ample-tier GPU.*24GB/i.test(onRes.json?.error ?? ""), onRes.json?.error);
  check("attempt-on never claims a fallback success", /honest failure, not a fallback/i.test(onRes.json?.error ?? ""));

  const autoRes = await req(s1.base, "/api/power", { method: "POST", headers: bearer, body: { mode: "auto" } });
  check("auto → follows detection (unavailable on lean)", autoRes.json?.available === false && autoRes.json?.override === "auto");

  // persistence: set attempt-on, re-read, override survives
  await req(s1.base, "/api/power", { method: "POST", headers: bearer, body: { mode: "attempt-on" } });
  const persisted = await req(s1.base, "/api/power", { method: "GET" });
  check("override persists (survives re-read)", persisted.json?.override === "attempt-on" && persisted.json?.attemptFailed === true);
  await new Promise((r) => setTimeout(r, 200));
  check("gpu.power_override audited", audit(ROOT_LEAN, "gpu.power_override").length >= 1);
  check("gpu.power_attempt_failed audited (explicit failure record)", audit(ROOT_LEAN, "gpu.power_attempt_failed").some((e) => /24GB/.test(e.payload?.error ?? "")));
  const af = audit(ROOT_LEAN, "gpu.power_attempt_failed").pop();
  if (af) console.log(`  failure audit verbatim: ${JSON.stringify(af.payload)}`);
  kill(s1.server);

  // ===== Gate 3: FORCED ample (mock, audited as forced) =====
  console.log("\n=== Gate 3: POWER-tier mock-verified (forced ample; no real ≥24GB hardware) ===");
  const s2 = await runServer(7934, ROOT_AMPLE, { ARGOS_FORCE_GPU_PROFILE: "NVIDIA RTX 5090,24576" });
  const gpu2 = await req(s2.base, "/api/gpu", { method: "GET" });
  check("forced profile detects ample tier", gpu2.json?.tier === "ample" && gpu2.json?.source === "forced", `(tier=${gpu2.json?.tier}, source=${gpu2.json?.source})`);
  const pwr2 = await req(s2.base, "/api/power", { method: "GET" });
  check("Power Mode AVAILABLE on forced ample", pwr2.json?.available === true);
  const tok2 = await token(s2.base);
  const onAmple = await req(s2.base, "/api/power", { method: "POST", headers: { authorization: `Bearer ${tok2}` }, body: { mode: "attempt-on" } });
  check("operator attempt-on SUCCEEDS on ample (in code)", onAmple.json?.available === true && onAmple.json?.attemptFailed === false);
  await new Promise((r) => setTimeout(r, 200));
  check("forced override audited as forced (honesty: no faked hardware claim)", audit(ROOT_AMPLE, "gpu.profile_forced").some((e) => /not real hardware/i.test(e.payload?.note ?? "")));
  kill(s2.server);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { fs.rmSync(ROOT_LEAN, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(ROOT_AMPLE, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase7-power-override: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
