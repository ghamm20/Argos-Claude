#!/usr/bin/env node
// smoke-dispatcher.mjs — Phase 11 Dispatcher gate.
//
// Spins a dedicated `next start` with a tmp ARGOS_ROOT (seeded with the
// skills/ dir) and exercises the dispatcher via /api/dispatch. The POST
// accepts a `mockResponse` test hook so the OK-suppress / actionable
// paths are deterministic without a live model.
//
// Gate cases (all must pass):
//   1. Security event  → routes to Bartimaeus
//   2. Research event  → routes to Sage
//   3. Ops event       → routes to Bobby
//   4. DISPATCH_OK     → suppressed (status ok), no alert, memory written
//   5. Actionable      → alert payload BUILT (fired=false, no creds), memory written
//   6. Daily log created at memory/YYYY-MM-DD.md
//   7. MEMORY.md appended with the event
//   + skill injected (skillUsed set) + GET /api/dispatch status shape
//
// Usage: node scripts/smoke-dispatcher.mjs [--port 7797]

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 7797;
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
    const r = await req("/api/dispatch");
    if (r.ok && r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

function dispatch(type, content, mockResponse) {
  return req("/api/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, content, source: "smoke", mockResponse }),
  });
}

const tmpRoot = mkdtempSync(join(tmpdir(), "argos-dispatcher-smoke-"));
// Seed ALL skills/ into the tmp ARGOS_ROOT so multi-skill injection is
// genuinely exercised (e.g. security events inject security-triage AND
// threat-assessment). skillUsed remains the FIRST/primary skill, so the
// per-persona skillUsed assertions below are unaffected.
mkdirSync(join(tmpRoot, "skills"), { recursive: true });
const repoSkillsDir = join(repoRoot, "skills");
if (existsSync(repoSkillsDir)) {
  for (const f of readdirSync(repoSkillsDir).filter((f) => f.endsWith(".md"))) {
    copyFileSync(join(repoSkillsDir, f), join(tmpRoot, "skills", f));
  }
}
const memDir = join(tmpRoot, "memory");
const memoryFile = join(memDir, "MEMORY.md");
const today = new Date().toISOString().slice(0, 10);
const dailyFile = join(memDir, `${today}.md`);

console.log(`smoke-dispatcher  ARGOS_ROOT=${tmpRoot}  port=${PORT}`);

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

  // --- 1. Security → Bartimaeus (actionable) ---
  console.log("=== 1. Security event → Bartimaeus ===");
  let r = await dispatch(
    "security",
    "Unauthorized login to the admin panel from an unfamiliar IP at 02:14.",
    "Unfamiliar IP accessed the admin panel. Block 203.0.113.7 and rotate admin creds."
  );
  check("security → 200 ok", r.ok && r.status === 200 && r.json?.ok === true);
  check("security → persona bartimaeus", r.json?.result?.persona === "bartimaeus", `got ${r.json?.result?.persona}`);
  check("security → skill security-triage injected", r.json?.result?.skillUsed === "security-triage", `got ${r.json?.result?.skillUsed}`);
  check("security → status actionable", r.json?.result?.status === "actionable", `got ${r.json?.result?.status}`);
  check("security → alert payload built, NOT fired (no creds)", !!r.json?.result?.alert && r.json.result.alert.fired === false);
  check("security → memoryWritten true", r.json?.result?.memoryWritten === true);

  // --- 2. Research → Sage (DISPATCH_OK suppressed) ---
  console.log("\n=== 2. Research event → Sage (DISPATCH_OK suppressed) ===");
  r = await dispatch("research", "Another restated headline about a local LLM benchmark.", "DISPATCH_OK");
  check("research → persona sage", r.json?.result?.persona === "sage", `got ${r.json?.result?.persona}`);
  check("research → skill research-synthesis injected", r.json?.result?.skillUsed === "research-synthesis");
  check("research → status ok (suppressed)", r.json?.result?.status === "ok", `got ${r.json?.result?.status}`);
  check("research → NO alert", r.json?.result?.alert === null);
  check("research → memoryWritten true (logged even when suppressed)", r.json?.result?.memoryWritten === true);

  // --- 3. Ops → Bobby (actionable) ---
  console.log("\n=== 3. Ops event → Bobby ===");
  r = await dispatch("ops", "Vault drive D: at 92% capacity.", "Disk at 92% — prune old logs before the next ingest or the write fails.");
  check("ops → persona bobby", r.json?.result?.persona === "bobby", `got ${r.json?.result?.persona}`);
  check("ops → skill ops-dispatch injected", r.json?.result?.skillUsed === "ops-dispatch");
  check("ops → status actionable", r.json?.result?.status === "actionable", `got ${r.json?.result?.status}`);
  const opsAlert = r.json?.result?.alert ?? null;
  check("ops → alert payload constructed", !!opsAlert && typeof opsAlert.title === "string" && typeof opsAlert.message === "string");
  check("ops → alert message carries the content (92%)", !!opsAlert && /92%/.test(opsAlert.message));
  check("ops → alert NOT fired (no creds)", !!opsAlert && opsAlert.fired === false, opsAlert ? `reason="${opsAlert.reason}"` : "");

  // --- 4. Comms → Juniper (routing-only sanity, no skill) ---
  console.log("\n=== 4. Comms event → Juniper ===");
  r = await dispatch("comms", "Draft a reply thanking the vendor for the meeting.", "DISPATCH_OK");
  check("comms → persona juniper", r.json?.result?.persona === "juniper", `got ${r.json?.result?.persona}`);

  // --- 5. Memory files: daily log + MEMORY.md ---
  console.log("\n=== 5. Markdown memory written ===");
  check("daily log created at memory/YYYY-MM-DD.md", existsSync(dailyFile), dailyFile);
  check("MEMORY.md created", existsSync(memoryFile), memoryFile);
  if (existsSync(memoryFile)) {
    const mem = readFileSync(memoryFile, "utf8");
    check("MEMORY.md has long-term header", /# ARGOS — MEMORY\.md/.test(mem));
    check("MEMORY.md appended the security event", /admin panel/i.test(mem));
    check("MEMORY.md appended the ops event (92%)", /92%/.test(mem));
    check("MEMORY.md records routed personas", /Bartimaeus/.test(mem) && /Bobby/.test(mem) && /Sage/.test(mem));
  }
  if (existsSync(dailyFile)) {
    const day = readFileSync(dailyFile, "utf8");
    check("daily log has day header", new RegExp(`# ARGOS daily log — ${today}`).test(day));
  }

  // --- 6. GET /api/dispatch status shape ---
  console.log("\n=== 6. GET /api/dispatch status ===");
  const s = await req("/api/dispatch");
  check("status 200", s.ok && s.status === 200);
  const j = s.json ?? {};
  for (const key of ["lastEventAt", "lastType", "lastPersona", "lastStatus", "count", "byPersona", "memoryFile"]) {
    check(`status has \`${key}\``, key in j);
  }
  check("status.count >= 4", (j.count ?? 0) >= 4, `count=${j.count}`);

  // --- 7. Graceful: bad request ---
  console.log("\n=== 7. Graceful validation ===");
  const bad = await req("/api/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "no type" }) });
  check("missing type → 400", bad.ok && bad.status === 400);

  // --- 8. Invalid type → 400 (type not in allowed set) ---
  //   Isolated forwarded-IP so this never touches the functional bucket.
  console.log("\n=== 8. Invalid type → 400 ===");
  const badType = await req("/api/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.77.0.3" },
    body: JSON.stringify({ type: "bogus-not-allowed", content: "x", source: "smoke" }),
  });
  check("invalid type → 400", badType.ok && badType.status === 400, `(${badType.status})`);
  check("invalid type error names the allowed set", typeof badType.json?.error === "string" && /security/.test(badType.json.error));

  // --- 9. Idempotency: duplicate X-Dispatch-Id → cached, no re-dispatch ---
  console.log("\n=== 9. Idempotency (X-Dispatch-Id) ===");
  const idemHeaders = {
    "content-type": "application/json",
    "x-forwarded-for": "10.77.0.2",
    "x-dispatch-id": "smoke-idem-001",
  };
  const idemBody = JSON.stringify({ type: "ops", content: "Idempotency probe — disk at 80%.", source: "smoke", mockResponse: "DISPATCH_OK" });
  const first = await req("/api/dispatch", { method: "POST", headers: idemHeaders, body: idemBody });
  const second = await req("/api/dispatch", { method: "POST", headers: idemHeaders, body: idemBody });
  check("idempotent first request → 200", first.ok && first.status === 200);
  check("idempotent replay flagged (idempotentReplay:true)", second.json?.idempotentReplay === true);
  check(
    "idempotent replay returns SAME result — no re-dispatch",
    !!first.json?.result?.at && second.json?.result?.at === first.json.result.at,
    `(${first.json?.result?.at} vs ${second.json?.result?.at})`
  );

  // --- 10. Rate limit: 11 rapid requests from one IP → 11th = 429 ---
  console.log("\n=== 10. Rate limit (10/min/IP) ===");
  const rlHeaders = { "content-type": "application/json", "x-forwarded-for": "10.77.0.1" };
  const rlBody = JSON.stringify({ type: "ops", content: "rate probe", source: "smoke", mockResponse: "DISPATCH_OK" });
  let okCount = 0;
  let got429 = false;
  for (let i = 1; i <= 11; i++) {
    const r = await req("/api/dispatch", { method: "POST", headers: rlHeaders, body: rlBody });
    if (r.status === 200) okCount++;
    if (i === 11) got429 = r.status === 429;
  }
  check("first 10 requests within limit → 200", okCount === 10, `(${okCount}/10 ok)`);
  check("11th request → 429", got429);
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
console.log(`smoke-dispatcher: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
