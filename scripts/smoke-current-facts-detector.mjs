#!/usr/bin/env node
// smoke-current-facts-detector.mjs — forced-tool detector gate (2026-06-02).
//
// Verifies detectCurrentFacts via /api/current-facts (pure, no model):
//   - weather queries trigger (incl. "temp in", "how hot", typo "forxast")
//   - the operator's failing real example fires with confidence > 0.7
//   - weather queries are reshaped to "weather forecast <location> today"
//   - office-holder / price / time-relative still fire
//   - clearly-historical + general-knowledge queries do NOT fire
//
// Usage: node scripts/smoke-current-facts-detector.mjs [--port 7845]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7845;

let pass = 0,
  fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`);
  }
}

function get(base, q) {
  return new Promise((res) => {
    const url = new URL("/api/current-facts", base);
    url.searchParams.set("q", q);
    http
      .get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 8000 }, (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          try {
            res(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            res(null);
          }
        });
      })
      .on("error", () => res(null));
  });
}

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await get(base, "ping");
    if (r && r.ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(port, fn) {
  console.log(`\n[boot] current-facts — next start :${port}`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: repoRoot }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready");
    await fn(base);
  } finally {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      else server.kill("SIGKILL");
    } catch {
      /* best effort */
    }
  }
}

try {
  await withServer(BASE_PORT, async (base) => {
    // ===== the operator's failing real example =====
    console.log("\n=== weather: the failing real example ===");
    const d1 = (await get(base, "what is the temp in wintersprings florida right now")).detection;
    check("requiresTool true", d1.requiresTool === true, JSON.stringify(d1));
    check("confidence > 0.7", d1.confidence > 0.7, `(${d1.confidence})`);
    check("category weather", d1.category === "weather");
    check("query reshaped to weather forecast", /weather forecast/i.test(d1.suggestedQuery) && /florida/i.test(d1.suggestedQuery), d1.suggestedQuery);

    // ===== weather variants incl. typos =====
    console.log("\n=== weather variants + typos ===");
    check("'temp in' triggers", (await get(base, "temp in miami")).detection.requiresTool === true);
    check("'how hot' triggers", (await get(base, "how hot is it in phoenix today")).detection.category === "weather");
    check("'forecast' triggers", (await get(base, "forecast for orlando this weekend")).detection.requiresTool === true);
    const fx = (await get(base, "the forxast for orlando")).detection;
    check("typo 'forxast' triggers (fuzzy)", fx.requiresTool === true && fx.category === "weather", `(${fx.reason})`);
    check("'raining' triggers", (await get(base, "is it raining in seattle")).detection.category === "weather");

    // ===== other current-facts still fire =====
    console.log("\n=== other current-facts ===");
    check("president 2026 fires", (await get(base, "who is the president of the united states in 2026")).detection.requiresTool === true);
    check("bitcoin price fires", (await get(base, "bitcoin price right now")).detection.requiresTool === true);
    check("'latest news' fires", (await get(base, "latest news on the election")).detection.requiresTool === true);

    // ===== negatives: must NOT fire =====
    console.log("\n=== negatives (must not force a tool) ===");
    check("historical 'who was the first president' does NOT fire", (await get(base, "who was the first president of the united states")).detection.requiresTool === false);
    check("general knowledge does NOT fire", (await get(base, "explain how photosynthesis works")).detection.requiresTool === false);
    check("plain math does NOT fire", (await get(base, "what is 17 times 23")).detection.requiresTool === false);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
}

console.log(`\nsmoke-current-facts-detector: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
