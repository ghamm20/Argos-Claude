#!/usr/bin/env node
// smoke-current-facts-detector.mjs — forced-tool detector gate (2026-06-02).
//
// Verifies detectCurrentFacts via /api/current-facts (pure, no model):
//   - weather queries trigger (incl. "temp in", "how hot", typo "forxast")
//   - the operator's failing real example fires with confidence > 0.7
//   - weather queries route to open_meteo_weather with the extracted location
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
    // 2026-06-02: weather no longer reshapes to a DDG query — it routes to the
    // open_meteo_weather tool with the extracted place as `location`.
    check("weather → open_meteo_weather tool", d1.suggestedTool === "open_meteo_weather", `tool=${d1.suggestedTool}`);
    check("location extracted (florida)", /florida/i.test(d1.location ?? "") && !/weather|forecast|temp/i.test(d1.location ?? ""), `loc=${d1.location}`);

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

    // ===== chain-first routing (Problem 1, 2026-06-02) =====
    console.log("\n=== chain routing + re-search requests ===");
    const ceo = (await get(base, "who is the CEO of Lever Soap")).detection;
    check("CEO query → chain_search_to_read", ceo.requiresTool === true && ceo.suggestedTool === "chain_search_to_read", `tool=${ceo.suggestedTool}`);
    const go = (await get(base, "go look on the internet")).detection;
    check("'go look' fires + uses prior message", go.requiresTool === true && go.usePriorMessage === true && go.suggestedTool === "chain_search_to_read", `tool=${go.suggestedTool} prior=${go.usePriorMessage}`);
    const look = (await get(base, "look it up")).detection;
    check("'look it up' fires", look.requiresTool === true && look.usePriorMessage === true);
    const search = (await get(base, "search the web for that")).detection;
    check("'search the web' fires", search.requiresTool === true && search.usePriorMessage === true);
    // weather still routes to open_meteo, not chain
    check("weather still → open_meteo_weather", (await get(base, "temp in miami")).detection.suggestedTool === "open_meteo_weather");

    // ===== negatives: must NOT fire =====
    console.log("\n=== negatives (must not force a tool) ===");
    check("historical 'who was the first president' does NOT fire", (await get(base, "who was the first president of the united states")).detection.requiresTool === false);
    check("general knowledge does NOT fire", (await get(base, "explain how photosynthesis works")).detection.requiresTool === false);
    check("plain math does NOT fire", (await get(base, "what is 17 times 23")).detection.requiresTool === false);

    // ===== weather false-positives (2026-06-03 fix): temperature words/units
    // in physics/cooking/medical STATEMENTS must NOT trigger a weather fetch.
    console.log("\n=== weather false-positives (units ≠ weather) ===");
    const boil = (await get(base, "water boils at 100 degrees Celsius at sea level")).detection;
    check("'100 degrees Celsius' physics fact does NOT fire", boil.requiresTool === false, JSON.stringify(boil));
    check("oven '350 degrees Fahrenheit' does NOT fire", (await get(base, "set the oven to 350 degrees Fahrenheit")).detection.requiresTool === false);
    check("'body temperature is 98.6 degrees' does NOT fire", (await get(base, "normal body temperature is 98.6 degrees")).detection.requiresTool === false);
    check("'convert 100 celsius to fahrenheit' does NOT fire", (await get(base, "convert 100 celsius to fahrenheit")).detection.requiresTool === false);
    check("'the angle is 90 degrees' does NOT fire", (await get(base, "the angle is 90 degrees")).detection.requiresTool === false);
    // …but a temperature word WITH weather context still fires.
    check("'how many degrees outside' still fires", (await get(base, "how many degrees is it outside right now")).detection.category === "weather");
    check("'temperature in Orlando' still fires", (await get(base, "what is the temperature in Orlando")).detection.category === "weather");

    // ===== social-intent guard (2026-06-03 fix): a sentiment must NEVER force a
    // tool, even with a temporal marker ("today"). =====
    console.log("\n=== social-intent guard (sentiment ≠ tool) ===");
    const thx = (await get(base, "thank you for your help today")).detection;
    check("'thank you ... today' does NOT fire", thx.requiresTool === false && thx.reason === "social", JSON.stringify(thx));
    check("'thanks!' does NOT fire", (await get(base, "thanks!")).detection.requiresTool === false);
    check("'good morning' does NOT fire", (await get(base, "good morning")).detection.requiresTool === false);
    check("'good night, see you tomorrow' does NOT fire", (await get(base, "good night, see you tomorrow")).detection.requiresTool === false);
    check("'I appreciate the work today' does NOT fire", (await get(base, "I appreciate the work you did today")).detection.requiresTool === false);
    check("'sorry for the confusion earlier' does NOT fire", (await get(base, "sorry for the confusion earlier today")).detection.requiresTool === false);
    check("'noted' does NOT fire", (await get(base, "noted")).detection.requiresTool === false);
    check("'ok' does NOT fire", (await get(base, "ok")).detection.requiresTool === false);
    check("'you're right' does NOT fire", (await get(base, "you're right")).detection.requiresTool === false);
    check("'love you, bart' does NOT fire", (await get(base, "love you, bart")).detection.requiresTool === false);
    // …but a greeting + a real request STILL fires, and a courtesy-prefixed
    // QUESTION still fires (social guard must not swallow genuine queries).
    check("'hey what's the weather in Miami today' STILL fires", (await get(base, "hey what's the weather in Miami today")).detection.category === "weather");
    check("'thanks, but who is the CEO of Levi Strauss?' STILL fires", (await get(base, "thanks, but who is the CEO of Levi Strauss?")).detection.requiresTool === true);
    check("'good morning — who is the president in 2026?' STILL fires", (await get(base, "good morning — who is the president in 2026?")).detection.requiresTool === true);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
}

console.log(`\nsmoke-current-facts-detector: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
