#!/usr/bin/env node
// smoke-persona-router.mjs — Phase 9 (router) gate.
//
// Spins a dedicated `next start` with a tmp ARGOS_ROOT and exercises
// POST /api/route (keyword-only, deterministic — no Ollama needed) on
// the five mandatory routing cases. GATE: all five must route to the
// expected persona. Zero wrong routes = PASS.
//
// Also checks: confidence clears the 0.7 gate on each case, the
// endpoint never 500s, graceful degradation on empty/garbage input,
// and reports per-call latency (the keyword happy path).
//
// Usage: node scripts/smoke-persona-router.mjs [--port 7795]

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 7795;
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
    const started = Date.now();
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
        agent,
        timeout: opts.timeoutMs || 30_000,
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
          resolveResult({
            ok: true,
            status: res.statusCode,
            json,
            body,
            ms: Date.now() - started,
          });
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
    const r = await req("/api/route");
    if (r.ok && r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

function postRoute(query, extra = {}) {
  return req("/api/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, ...extra }),
  });
}

// The five mandatory cases (directive Task 5).
const CASES = [
  { q: "What's the legal standard for probable cause?", expect: "bartimaeus" },
  { q: "Summarize the latest AI research trends", expect: "sage" },
  { q: "Why does my for loop keep breaking?", expect: "bobby" },
  { q: "I'm feeling overwhelmed with the project", expect: "juniper" },
  { q: "Plan a 3-phase rollout for our new system", expect: "bartimaeus" },
];

const tmpRoot = mkdtempSync(join(tmpdir(), "argos-router-smoke-"));
console.log(`smoke-persona-router  ARGOS_ROOT=${tmpRoot}  port=${PORT}`);

let server = null;
const latencies = [];
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

  console.log("=== A. Five mandatory routing cases (keyword-only) ===");
  let correct = 0;
  for (const c of CASES) {
    const r = await postRoute(c.q); // keyword-only; no model
    if (!r.ok || r.status !== 200 || !r.json) {
      check(`route "${c.q.slice(0, 32)}…"`, false, `(http ${r.status ?? r.error})`);
      continue;
    }
    latencies.push(r.ms);
    const got = r.json.recommended;
    const ok = got === c.expect;
    if (ok) correct++;
    check(
      `"${c.q.slice(0, 38)}…" → ${c.expect}`,
      ok,
      `got=${got} conf=${(r.json.confidence ?? 0).toFixed(2)} method=${r.json.method} ${r.ms}ms`
    );
    // Each mandatory case must also clear the 0.7 surface gate.
    check(
      `   ↳ confidence ≥ 0.7 + surface`,
      (r.json.confidence ?? 0) >= 0.7 && r.json.recommended === c.expect,
      `conf=${(r.json.confidence ?? 0).toFixed(2)}`
    );
  }
  console.log(`\n  >>> ${correct}/5 routed correctly (gate: 5/5)`);

  console.log("\n=== B. Graceful degradation ===");
  const empty = await postRoute("");
  check("empty query → 400 (no crash)", empty.ok && empty.status === 400);
  const garbage = await postRoute("asdfqwerzxcv lkjhgfd");
  check(
    "garbage query → 200, low confidence, no surface",
    garbage.ok &&
      garbage.status === 200 &&
      garbage.json &&
      garbage.json.surface === false,
    `conf=${(garbage.json?.confidence ?? 0).toFixed(2)} rec=${garbage.json?.recommended}`
  );
  const getProbe = await req("/api/route");
  check("GET /api/route → 200 (discovery)", getProbe.ok && getProbe.status === 200);

  console.log("\n=== C. Latency (keyword happy path) ===");
  const avg = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : -1;
  const max = latencies.length ? Math.max(...latencies) : -1;
  console.log(`  per-call round-trip: avg ${avg}ms, max ${max}ms (incl. HTTP + Next)`);
  check("round-trip latency sane (< 500ms avg)", avg >= 0 && avg < 500, `avg=${avg}ms`);
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
const gateMsg = fail === 0 ? "PASS" : "FAIL";
console.log(`smoke-persona-router: ${pass} passed, ${fail} failed — ${gateMsg}`);
process.exit(fail === 0 ? 0 : 1);
