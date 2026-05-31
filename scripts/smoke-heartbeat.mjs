#!/usr/bin/env node
// smoke-heartbeat.mjs — Phase 10 Heartbeat gate.
//
// Spins a dedicated `next start` with a tmp ARGOS_ROOT and exercises
// the heartbeat dispatcher via /api/heartbeat/{status,trigger}. The
// trigger endpoint accepts a `mockResponse` test hook so the decision
// + alert-payload paths are deterministic without a live model.
//
// Gate cases (all must pass):
//   1. Empty HEARTBEAT.md      → tick skipped_empty, no alert
//   2. Missing HEARTBEAT.md    → tick runs (model decides), not skipped
//   3. HEARTBEAT_OK response   → suppressed (status ok), no alert
//   4. Actionable response     → Pushover payload BUILT, fired=false
//                                (no creds = mocked send; verify payload)
//   5. GET /status             → correct shape
//   6. POST /trigger           → fires immediately, returns a result
//
// Usage: node scripts/smoke-heartbeat.mjs [--port 7796]

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 7796;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`);
  }
}

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    let url;
    try {
      url = new URL(path, BASE);
    } catch (e) {
      resolveResult({ ok: false, error: e.message });
      return;
    }
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
        agent,
        timeout: opts.timeoutMs || 60_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* leave null */
          }
          resolveResult({ ok: true, status: res.statusCode, json, body });
        });
      }
    );
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function waitReady(maxSec = 40) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req("/api/heartbeat/status");
    if (r.ok && r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

function trigger(mockResponse) {
  return req("/api/heartbeat/trigger", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mockResponse === undefined ? {} : { mockResponse }),
  });
}

const tmpRoot = mkdtempSync(join(tmpdir(), "argos-heartbeat-smoke-"));
const hbFile = join(tmpRoot, "HEARTBEAT.md");
console.log(`smoke-heartbeat  ARGOS_ROOT=${tmpRoot}  port=${PORT}`);

let server = null;
try {
  console.log(`\n[boot] next start on ${PORT}`);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT: tmpRoot, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  if (!(await waitReady(40))) throw new Error("server did not become ready");
  console.log("[boot] ready\n");

  // --- Case 1: empty HEARTBEAT.md → skipped_empty, no alert ---
  console.log("=== 1. Empty HEARTBEAT.md → tick skipped, no alert ===");
  writeFileSync(hbFile, "   \n  \n", "utf8");
  let r = await trigger("this should be IGNORED because file is empty");
  check("empty → trigger 200 + ok", r.ok && r.status === 200 && r.json?.ok === true);
  check(
    "empty → status skipped_empty",
    r.json?.result?.status === "skipped_empty",
    `status=${r.json?.result?.status}`
  );
  check("empty → no alert", r.json?.result?.alert === null);

  // --- Case 2: missing HEARTBEAT.md → tick runs (model decides) ---
  console.log("\n=== 2. Missing HEARTBEAT.md → tick runs (not skipped) ===");
  if (existsSync(hbFile)) unlinkSync(hbFile);
  r = await trigger("HEARTBEAT_OK"); // mock stands in for the model
  check("missing → trigger 200", r.ok && r.status === 200 && r.json?.ok === true);
  check(
    "missing → tick RAN (status not skipped_*)",
    typeof r.json?.result?.status === "string" &&
      !r.json.result.status.startsWith("skipped"),
    `status=${r.json?.result?.status}`
  );
  check("missing → checklistPresent false", r.json?.result?.checklistPresent === false);

  // --- Case 3: HEARTBEAT_OK → suppressed, no alert ---
  console.log("\n=== 3. HEARTBEAT_OK response → suppressed, no alert ===");
  writeFileSync(hbFile, "- Check disk space\n- Check uptime\n", "utf8");
  r = await trigger("HEARTBEAT_OK");
  check("ok → status ok", r.json?.result?.status === "ok", `status=${r.json?.result?.status}`);
  check("ok → no alert (suppressed)", r.json?.result?.alert === null);

  // --- Case 4: actionable → payload BUILT, not fired ---
  console.log("\n=== 4. Actionable response → Pushover payload built, NOT fired ===");
  r = await trigger(
    "Vault drive D: is at 92% capacity. Free space before the next ingest or the write will fail."
  );
  check("actionable → status actionable", r.json?.result?.status === "actionable", `status=${r.json?.result?.status}`);
  const alert = r.json?.result?.alert ?? null;
  check("actionable → alert payload constructed", !!alert && typeof alert.title === "string" && typeof alert.message === "string");
  check("actionable → alert.title set", !!alert && alert.title.length > 0, alert ? `title="${alert.title}"` : "");
  check("actionable → message carries the triage text", !!alert && /92%/.test(alert.message));
  check(
    "actionable → NOT fired (no creds = mocked send)",
    !!alert && alert.fired === false,
    alert ? `reason="${alert.reason}"` : ""
  );

  // --- Case 5: /status shape ---
  console.log("\n=== 5. GET /api/heartbeat/status shape ===");
  const s = await req("/api/heartbeat/status");
  check("status 200", s.ok && s.status === 200);
  const j = s.json ?? {};
  for (const key of ["enabled", "running", "intervalMinutes", "lastTickAt", "nextTickAt", "last", "counts", "checklistFile"]) {
    check(`status has \`${key}\``, key in j);
  }
  check("status.counts.ticks ≥ 4 (we triggered ≥4 times)", (j.counts?.ticks ?? 0) >= 4, `ticks=${j.counts?.ticks}`);

  // --- Case 6: /trigger fires immediately ---
  console.log("\n=== 6. POST /api/heartbeat/trigger fires immediately ===");
  const t0 = Date.now();
  const tr = await trigger("HEARTBEAT_OK");
  const ms = Date.now() - t0;
  check("trigger 200 + ok:true", tr.ok && tr.status === 200 && tr.json?.ok === true);
  check("trigger returns a result with a status + timestamp", typeof tr.json?.result?.status === "string" && typeof tr.json?.result?.at === "string");
  check("trigger responded fast (< 5s, mocked path)", ms < 5000, `${ms}ms`);
} catch (e) {
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
  fail++;
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGKILL");
      }
    } catch {}
  }
  agent.destroy();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}

console.log("");
console.log(`smoke-heartbeat: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
