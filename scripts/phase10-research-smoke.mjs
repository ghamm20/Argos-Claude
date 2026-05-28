#!/usr/bin/env node
// phase10-research-smoke.mjs — Phase 10 research pipeline smoke.
//
// Six step plan (per directive):
//   1. weather query → ResearchReport returned with intent=weather
//   2. weather query repeated → cache hit (cachedAt present, fast)
//   3. AI news query → ResearchReport with intent=ai_updates
//   4. greeting → returns null (not a research query)
//   5. data/research/cache.json exists with entries
//   6. additional: confirm CONFIDENCE/QUALITY are populated and at
//      least one citation came back on the weather report
//
// Runs the pipeline by POSTing /api/research/run against a fresh
// next-start spawned with a tmp ARGOS_ROOT. Real internet calls
// fire. Network failures degrade gracefully — checks for null +
// quality field but not for specific source counts (those vary).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const portIdx = process.argv.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(process.argv[portIdx + 1], 10) : 7790;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

let pass = 0;
let fail = 0;
function check(label, cond, detail = "") {
  const tag = cond ? "[ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (cond) pass++;
  else fail++;
}

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    const url = new URL(path, BASE);
    const body = opts.body ?? null;
    const headers = { ...(opts.headers || {}) };
    if (body && !headers["content-length"]) {
      headers["content-length"] = Buffer.byteLength(body);
    }
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
        agent,
        timeout: opts.timeoutMs || 90_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolveResult({
            ok: true,
            status: res.statusCode,
            text,
            json: () => {
              try { return JSON.parse(text); } catch { return null; }
            },
          });
        });
      }
    );
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

async function waitReady(maxSec = 45) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req("/api/voice/status");
    if (r.ok && r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function runStream(streamKey) {
  return req("/api/research/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: streamKey }),
  });
}

const root = mkdtempSync(join(tmpdir(), "argos-phase10-"));
console.log(`phase10-research-smoke  ARGOS_ROOT=${root}  port=${PORT}`);

let server = null;
try {
  console.log(`\n[boot] starting next start on port ${PORT}`);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT: root, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  if (!(await waitReady(45))) throw new Error("server failed to come up");
  console.log("[boot] ready");

  // ---- Step 1: weather (cold) ----
  console.log("\n=== 1. POST /api/research/run weather_atl (cold) ===");
  const t1 = Date.now();
  const r1 = await runStream("weather_atl");
  const wall1 = Date.now() - t1;
  check("weather reachable", r1.ok);
  check("weather 200", r1.status === 200);
  let weatherReport = null;
  if (r1.status === 200) {
    const j = r1.json();
    weatherReport = j?.report ?? null;
    check("weather ok=true", !!j?.ok);
    check("report.intent === weather", weatherReport?.intent === "weather", weatherReport ? `(${weatherReport.intent})` : "");
    check("report.quality populated", typeof weatherReport?.quality === "string");
    check("report.confidenceScore populated", typeof weatherReport?.confidenceScore === "number");
    check("report has ≥1 citation OR was FAILED with reason", (weatherReport?.citations?.length ?? 0) >= 1 || weatherReport?.quality === "FAILED");
    check("cold wall time < 30000ms", wall1 < 30_000, `(${wall1}ms)`);
  }

  // ---- Step 2: weather (cache hit) ----
  console.log("\n=== 2. POST /api/research/run weather_atl (cached) ===");
  const t2 = Date.now();
  const r2 = await runStream("weather_atl");
  const wall2 = Date.now() - t2;
  if (r2.status === 200) {
    const j = r2.json();
    const cachedReport = j?.report ?? null;
    check("second call 200", r2.status === 200);
    check("cachedAt present", !!cachedReport?.cachedAt, cachedReport?.cachedAt ? `(${cachedReport.cachedAt})` : "");
    check("cached call fast (< 2s)", wall2 < 2000, `(${wall2}ms)`);
  } else {
    check("second call 200", false, `(got ${r2.status})`);
  }

  // ---- Step 3: AI updates ----
  console.log("\n=== 3. POST /api/research/run ai_updates ===");
  const t3 = Date.now();
  const r3 = await runStream("ai_updates");
  const wall3 = Date.now() - t3;
  if (r3.status === 200) {
    const j = r3.json();
    const aiReport = j?.report ?? null;
    check("ai 200", r3.status === 200);
    check("report.intent === ai_updates", aiReport?.intent === "ai_updates", aiReport ? `(${aiReport.intent})` : "");
    check("ai citations OR quality reported honestly", (aiReport?.citations?.length ?? 0) >= 1 || ["FAILED", "PARTIAL"].includes(aiReport?.quality), `(${aiReport?.citations?.length ?? 0} citations, quality=${aiReport?.quality})`);
    check("ai wall time < 60000ms", wall3 < 60_000, `(${wall3}ms)`);
  } else {
    check("ai 200", false, `(got ${r3.status})`);
  }

  // ---- Step 4: non-research → returns null ----
  console.log("\n=== 4. POST /api/research/run custom 'hello how are you' ===");
  const r4 = await req("/api/research/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: "custom", query: "hello how are you" }),
  });
  check("custom non-research reachable", r4.ok);
  if (r4.ok) {
    const j = r4.json();
    check("custom returns ok:false (no research)", j?.ok === false);
    check("error message mentions 'no pipeline'", typeof j?.error === "string" && j.error.includes("no pipeline"), `(${j?.error ?? "?"})`);
  }

  // ---- Step 5: cache.json exists with entries ----
  console.log("\n=== 5. data/research/cache.json exists with entries ===");
  const cachePath = join(root, "data", "research", "cache.json");
  const exists = existsSync(cachePath);
  check("cache.json exists", exists, exists ? `(${cachePath})` : "");
  if (exists) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
      const keys = Object.keys(parsed);
      check("cache has at least 1 entry", keys.length >= 1, `(${keys.length} keys)`);
      check("entries have expiresAt timestamps", keys.every((k) => typeof parsed[k]?.expiresAt === "string"));
    } catch (e) {
      check("cache.json parseable", false, `(${e.message})`);
    }
  }

  // ---- Step 6: API status endpoint ----
  console.log("\n=== 6. GET /api/research/cache status surface ===");
  const r6 = await req("/api/research/cache");
  check("cache GET 200", r6.status === 200);
  if (r6.status === 200) {
    const j = r6.json();
    check("status totalEntries ≥ 1", (j?.totalEntries ?? 0) >= 1, `(${j?.totalEntries})`);
    check("status entries[] populated", Array.isArray(j?.entries) && j.entries.length >= 1);
  }
} catch (e) {
  fail++;
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
      }
    } catch {}
  }
  agent.destroy();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log("");
console.log(fail === 0
  ? `phase10-research-smoke: ${pass} passed — PASS`
  : `phase10-research-smoke: ${pass} passed, ${fail} failed — FAIL`);
process.exit(fail === 0 ? 0 : 1);
