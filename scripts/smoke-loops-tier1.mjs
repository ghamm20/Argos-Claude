#!/usr/bin/env node
// smoke-loops-tier1.mjs — Self-Evolving Loop Suite Tier 1 gate.
//
//   1. Benchmark v2: 35 tasks / 5 categories, deterministic grading.
//      all-correct → 1.0 with all 5 categories at 1.0; empty → 0.
//   2. New matchers grade correctly (word_count_max, not_contains,
//      sentence_count_max) — crafted failing answers fail those tasks.
//   3. Reflexion lesson recurrence: same failure 3× → failureCount reaches 3
//      (the recurring-failure tracker is real).
//   4. Trace analysis writes a daily failure report file.
//   5. Ouroboros maintains a live retrieval-threshold config (queryCount grows).
//   6. Memory consolidation runs gracefully (+ archive/quality when facts exist).
//   7. Scheduler now includes the weekly benchmark window.
//
// Usage: node scripts/smoke-loops-tier1.mjs [--port 7833]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7833;

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

function jreq(base, path, opts = {}) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: body ? { "content-type": "application/json", "content-length": body.length } : {},
        timeout: opts.timeoutMs || 120_000,
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* non-json */
          }
          res({ ok: true, status: resp.statusCode, json });
        });
      }
    );
    r.on("error", (e) => res({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await jreq(base, "/api/loops/status", { timeoutMs: 4000 });
    if (r.ok && r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(label, port, fn) {
  console.log(`\n[boot] ${label} — next start :${port}`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    {
      cwd: repoRoot,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: repoRoot },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
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
      if (process.platform === "win32")
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      else server.kill("SIGKILL");
    } catch {
      /* best effort */
    }
  }
}

const CORRECT = {
  "reason-1": "391", "reason-2": "12", "reason-3": "1024", "reason-4": "40", "reason-5": "5",
  "reason-6": "no", "reason-7": "Sue", "reason-8": "30", "reason-9": "32", "reason-10": "Thursday",
  "ret-1": "Paris", "ret-2": "Tokyo", "ret-3": "Au", "ret-4": "8", "ret-5": "Jupiter",
  "ret-6": "7", "ret-7": "Shakespeare", "ret-8": "water", "ret-9": "6", "ret-10": "1945",
  "tc-1": "red, blue, yellow", "tc-2": "mercury, venus, earth", "tc-3": "north south east west",
  "tc-4": "solid liquid gas", "tc-5": "heat water, add tea, then steep",
  "char-1": "blue", "char-2": "four", "char-3": "water is a clear flowing liquid", "char-4": "yes", "char-5": "Rome",
  "qual-1": "Gravity is a force.", "qual-2": "A firewall blocks traffic.", "qual-3": "cat on the mat",
  "qual-4": "Backups prevent data loss.", "qual-5": "Sleep restores the body and mind.",
};

try {
  await withServer("loops-tier1", BASE_PORT, async (base) => {
    // ===== 1. benchmark v2 grading =====
    console.log("\n=== 1. benchmark v2 (35 tasks / 5 categories) ===");
    const all = await jreq(base, "/api/loops/benchmark", { method: "POST", body: { answers: CORRECT } });
    check("35 tasks graded", all.json?.graded?.total === 35, `(${all.json?.graded?.total})`);
    check("all-correct → 1.0", all.json?.graded?.score === 1, `(${all.json?.graded?.score})`);
    const cats = all.json?.graded?.byCategory ?? {};
    check("5 categories present", ["reasoning", "retrieval", "tool_chain", "character", "quality"].every((c) => c in cats), Object.keys(cats).join(","));
    check("every category 1.0", Object.values(cats).every((c) => c.score === 1));
    const empty = await jreq(base, "/api/loops/benchmark", { method: "POST", body: { answers: {} } });
    check("empty → 0.0", empty.json?.graded?.score === 0);

    // ===== 2. new matchers =====
    console.log("\n=== 2. new matchers ===");
    const bad = { ...CORRECT, "char-2": "the answer to two plus two equals exactly four", "char-3": "water is wet", "qual-1": "Gravity. Is. A. Force." };
    const g = await jreq(base, "/api/loops/benchmark", { method: "POST", body: { answers: bad } });
    const per = Object.fromEntries((g.json?.graded?.perTask ?? []).map((t) => [t.id, t.passed]));
    check("word_count_max fails on too-many-words", per["char-2"] === false);
    check("not_contains fails when word present", per["char-3"] === false);
    check("sentence_count_max fails on multi-sentence", per["qual-1"] === false);
    check("untouched correct tasks still pass", per["reason-1"] === true && per["ret-1"] === true);

    // ===== 3. reflexion lesson recurrence =====
    console.log("\n=== 3. reflexion recurring-failure tracker ===");
    const failureText = "The web_crawl step timed out fetching an unreachable host and the task stalled.";
    let lastFc = 0;
    for (let i = 0; i < 3; i++) {
      const r = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "reflexion", input: { failure: failureText } }, timeoutMs: 120_000 });
      lastFc = r.json?.result?.data?.failureCount ?? lastFc;
    }
    check("same failure tracked as recurring (count >= 3)", lastFc >= 3, `(failureCount=${lastFc})`);

    // ===== 4. trace analysis failure report =====
    console.log("\n=== 4. trace analysis daily report ===");
    const ta = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "trace_analysis" }, timeoutMs: 120_000 });
    const reportPath = ta.json?.result?.data?.reportPath;
    check("trace analysis ran", ta.json?.ok === true);
    check("failure report file written", typeof reportPath === "string" && fs.existsSync(reportPath), reportPath ?? "");

    // ===== 5. ouroboros live threshold config =====
    console.log("\n=== 5. ouroboros retrieval-config tuning ===");
    const o1 = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "ouroboros_rag", input: { query: "operator security" } }, timeoutMs: 60_000 });
    const o2 = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "ouroboros_rag", input: { query: "operator security" } }, timeoutMs: 60_000 });
    check("ouroboros maintains a threshold", typeof o2.json?.result?.data?.threshold === "number");
    check("query counter increments", (o2.json?.result?.data?.queryCount ?? 0) > (o1.json?.result?.data?.queryCount ?? 0), `(${o1.json?.result?.data?.queryCount}→${o2.json?.result?.data?.queryCount})`);

    // ===== 6. memory consolidation (graceful) =====
    console.log("\n=== 6. memory consolidation ===");
    const mc = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "memory_consolidation" }, timeoutMs: 120_000 });
    check("memory consolidation ran ok", mc.json?.ok === true && mc.json?.result?.ok === true, mc.json?.result?.summary ?? "");

    // ===== 7. scheduler includes weekly benchmark =====
    console.log("\n=== 7. scheduler windows ===");
    const status = await jreq(base, "/api/loops/status");
    const windows = status.json?.scheduler?.windows ?? [];
    check("benchmark added to schedule (Sunday 5AM)", windows.some((w) => /5AM|weekly/i.test(w.label)), windows.map((w) => w.label).join(" | "));
    check("scheduled windows >= 5", windows.length >= 5, `(${windows.length})`);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try {
    fs.rmSync(join(repoRoot, "state", "loops"), { recursive: true, force: true });
    fs.rmSync(join(repoRoot, "restore", "loops"), { recursive: true, force: true });
    fs.rmSync(join(repoRoot, "data", "memory", "archive"), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log("\n[cleanup] removed loop runtime dirs");
}

console.log(`\nsmoke-loops-tier1: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
