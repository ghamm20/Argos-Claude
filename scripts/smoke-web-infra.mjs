#!/usr/bin/env node
// smoke-web-infra.mjs — Web Capability TIER 0 gate (2026-06-02).
//
// Verifies the shared web infrastructure through real code (diagnostic route),
// against a THROWAWAY ARGOS_ROOT so it never touches operator state:
//   - http-client: retry/backoff recovers from a flaky endpoint (500,500,200)
//   - cache: hit + TTL expiry
//   - rate-limiter: token bucket (burst 2 → 3rd denied with waitMs>0)
//   - audit: append + query
//   - /api/web/stats surfaces cache + rate + audit
//
// Usage: node scripts/smoke-web-infra.mjs [--port 7850]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7850;
const FLAKY_PORT = PORT + 1;
const ROOT = join(tmpdir(), `argos-web-infra-${process.pid}`);

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function req(base, path, opts = {}) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const r = http.request(
      { method: opts.method || "GET", hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: body ? { "content-type": "application/json", "content-length": body.length } : {}, timeout: 30000 },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
          res({ status: resp.statusCode, json });
        });
      }
    );
    r.on("error", () => res({ status: 0 }));
    r.on("timeout", () => r.destroy());
    if (body) r.write(body);
    r.end();
  });
}

// Flaky server: fails the first 2 requests per path with 500, then 200s.
function startFlaky() {
  const counts = new Map();
  const server = http.createServer((req2, res) => {
    const n = (counts.get(req2.url) ?? 0) + 1;
    counts.set(req2.url, n);
    if (n <= 2) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("flaky: try again");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, attempt: n }));
    }
  });
  return new Promise((res) => server.listen(FLAKY_PORT, "127.0.0.1", () => res(server)));
}

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req(base, "/api/web/stats");
    if (r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(fn) {
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`\n[boot] web-infra — next start :${PORT} (ARGOS_ROOT=${ROOT})`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready");
    await fn(base);
  } finally {
    try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  }
}

let flaky;
try {
  flaky = await startFlaky();
  console.log(`[boot] flaky endpoint on :${FLAKY_PORT}`);
  await withServer(async (base) => {
    const flakyUrl = `http://127.0.0.1:${FLAKY_PORT}/retry-test`;
    const st = await req(base, "/api/web/selftest", { method: "POST", body: { flakyUrl, nonce: String(process.pid) } });
    const j = st.json ?? {};

    console.log("\n=== http-client retry ===");
    check("recovers from 500,500,200", j.http?.ok === true, `attempts=${j.http?.attempts} status=${j.http?.status}`);
    check("took >=3 attempts", (j.http?.attempts ?? 0) >= 3, `attempts=${j.http?.attempts}`);

    console.log("\n=== cache ===");
    check("hit returns stored value", j.cache?.hit === true);
    check("expired entry misses", j.cache?.expiredMiss === true);

    console.log("\n=== rate-limiter ===");
    check("burst: 1st allowed", j.rate?.first === true);
    check("burst: 2nd allowed", j.rate?.second === true);
    check("burst: 3rd denied", j.rate?.third === false);
    check("3rd reports waitMs>0", (j.rate?.waitMs ?? 0) > 0, `waitMs=${j.rate?.waitMs}`);

    console.log("\n=== audit ===");
    check("append+query works", j.audit?.appended === true && j.audit?.bySource === true);

    console.log("\n=== /api/web/stats ===");
    const stats = await req(base, "/api/web/stats");
    check("stats: cache block", !!stats.json?.cache && typeof stats.json.cache.hitRate === "number");
    check("stats: rate block", Array.isArray(stats.json?.rate) && stats.json.rate.length > 0);
    check("stats: audit block", !!stats.json?.audit && typeof stats.json.audit.total === "number");
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { if (flaky) flaky.close(); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
  console.log("\n[cleanup] flaky closed + throwaway ARGOS_ROOT removed");
}

console.log(`\nsmoke-web-infra: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
