#!/usr/bin/env node
// test-realpath-bounding.mjs (Gate 2, 2026-06-09) — resolveWithinRoot must
// reject a symlink/junction INSIDE ARGOS_ROOT whose target is OUTSIDE it.
//
// Drives the REAL file_ops tool through /api/tools/execute on a throwaway
// ARGOS_ROOT (same pattern as validate-tool-parser.mjs) — so this tests the
// integrated production path (file-ops.validate → resolveWithinRoot), not a
// reimplementation.
//
// RED/GREEN in one run:
//   RED   — the verbatim PRE-FIX lexical-only check (copied from git) is shown
//           to ACCEPT the symlinked path (the escape it missed), and realpath
//           is shown to resolve that path OUTSIDE the root.
//   GREEN — the live endpoint (post-fix code) REJECTS the same path, and a
//           legitimate in-root file still reads (no false positive).
//
// Requires creating a junction (mklink /J — no admin on NTFS). If that fails
// (non-NTFS / restricted), the test SKIPS with an honest message — never a
// fake pass.
//
// Usage: node scripts/test-realpath-bounding.mjs [--port 7891]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7891;
const BASE = `http://127.0.0.1:${PORT}`;

const base = join(tmpdir(), `argos-realpath-${process.pid}`);
const ROOT = join(base, "root");
const OUTSIDE = join(base, "outside");

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

function post(path, body) {
  return new Promise((res) => {
    const payload = Buffer.from(JSON.stringify(body));
    const u = new URL(path, BASE);
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", "content-length": payload.length }, timeout: 20000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
    r.write(payload); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => {
      http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false));
    });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

// Verbatim PRE-FIX logic (lexical only) — copied from fs-guard.ts before Gate 2.
function preFixInside(root, p) {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  return !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
}

// ---- set up the throwaway tree + junction ----
fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(join(OUTSIDE, "secret.txt"), "OUTSIDE_SECRET_should_never_be_readable", "utf8");
fs.writeFileSync(join(ROOT, "workspace", "legit.txt"), "IN_ROOT_OK", "utf8");

const linkPath = join(ROOT, "workspace", "escape");
let junctionMade = false;
try {
  // mklink /J = directory junction; no admin needed on NTFS.
  const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, OUTSIDE], { encoding: "utf8" });
  junctionMade = r.status === 0 && fs.existsSync(linkPath);
  if (!junctionMade) console.log(`[setup] mklink /J output: ${(r.stdout || "") + (r.stderr || "")}`.trim());
} catch (e) {
  console.log(`[setup] junction creation threw: ${e.message}`);
}

if (!junctionMade) {
  console.log("\n[SKIP] Could not create a directory junction (non-NTFS or restricted).");
  console.log("       The realpath fix is still in fs-guard.ts; this environment just");
  console.log("       cannot stage the symlink. Not demonstrable here — reported honestly.");
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* */ }
  process.exit(0);
}

// ---- RED: show the pre-fix logic would have allowed the escape ----
console.log("=== RED: pre-fix (lexical-only) behavior on the symlinked path ===");
const reqPath = "workspace/escape/secret.txt";
const preFixVerdict = preFixInside(ROOT, reqPath);
check("pre-fix lexical check ACCEPTS workspace/escape/secret.txt (the missed escape)",
  preFixVerdict === true, `inside=${preFixVerdict}`);
let realResolved = "(unresolved)";
try { realResolved = fs.realpathSync(join(ROOT, reqPath)); } catch { /* */ }
const escapesRoot = !preFixInside(ROOT, realResolved);
check("…and realpath proves it resolves OUTSIDE the root",
  escapesRoot, `realpath=${realResolved}`);

// ---- GREEN: the live endpoint (post-fix) rejects it ----
const server = spawn(
  process.execPath,
  [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
);
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("\n=== GREEN: live file_ops via /api/tools/execute (post-fix code) ===");

  const escapeRes = await post("/api/tools/execute", {
    toolId: "file_ops",
    params: { operation: "read", path: reqPath },
  });
  const escErr = escapeRes?.result?.error ?? escapeRes?.error ?? "";
  check("symlink-escape read is REJECTED",
    escapeRes?.ok === false && /boundary|symlink|resolved safely/i.test(escErr), JSON.stringify(escErr));
  check("…and no OUTSIDE content was returned",
    !JSON.stringify(escapeRes ?? {}).includes("OUTSIDE_SECRET"), "no secret leaked");

  const legitRes = await post("/api/tools/execute", {
    toolId: "file_ops",
    params: { operation: "read", path: "workspace/legit.txt" },
  });
  check("legitimate in-root file still reads (no false positive)",
    legitRes?.ok === true && /IN_ROOT_OK/.test(JSON.stringify(legitRes?.result ?? {})), JSON.stringify(legitRes?.result?.summary ?? legitRes));
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  // Remove the junction FIRST (rmdir on a junction removes the link, not the
  // target) so the throwaway cleanup can't follow it into OUTSIDE.
  try { spawnSync("cmd", ["/c", "rmdir", linkPath]); } catch { /* */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\ntest-realpath-bounding: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
