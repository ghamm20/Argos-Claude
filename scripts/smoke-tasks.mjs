#!/usr/bin/env node
// smoke-tasks.mjs — Overnight Engine (2026-06-02) gate.
//
// Verifies the task queue + runner + morning brief end to end:
//   1. Task creation + queue pickup (POST create → file in queue).
//   2. State machine transitions (queued → running → complete) via pump.
//   3. Step execution with a tool (web_search) + a runner log written.
//   4. Retry logic — a step against an unreachable host retries then continues
//      (the whole task still completes; failure is logged, never aborts).
//   5. Morning brief generation (POST brief → file + content).
//   6. API route shapes (queue, [id]/log, brief).
//
// Spawns its own `next start` (ARGOS_ROOT = repo root). Requires Ollama for
// Bartimaeus planning. Cleans up the runtime tasks/ dir afterward.
//
// Usage: node scripts/smoke-tasks.mjs [--port 7825]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7825;

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
        timeout: opts.timeoutMs || 240_000,
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
    const r = await jreq(base, "/api/tasks/queue", { timeoutMs: 4000 });
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

const tasksDir = join(repoRoot, "tasks");

try {
  await withServer("tasks", BASE_PORT, async (base) => {
    // ===== 1. create + pickup =====
    console.log("\n=== 1. task creation + queue pickup ===");
    const create = await jreq(base, "/api/tasks/create", {
      method: "POST",
      body: {
        goal: "Search the web for site reliability engineering best practices.",
        steps: ["web_search"],
        priority: "high",
        notify_on: "complete",
      },
    });
    check("create returned ok", create.json?.ok === true);
    const id = create.json?.task?.id;
    check("task has an id", !!id, `(${id})`);
    const q1 = await jreq(base, "/api/tasks/queue");
    check("task appears in queue", (q1.json?.queued ?? []).some((t) => t.id === id));
    check("queue API shape", Array.isArray(q1.json?.queued) && Array.isArray(q1.json?.complete) && !!q1.json?.scheduler);

    // ===== 2 + 3. transition + step exec + log =====
    console.log("\n=== 2+3. run task (queued→running→complete) ===");
    const t0 = Date.now();
    const pump = await jreq(base, "/api/tasks/queue", { method: "POST", timeoutMs: 240_000 });
    console.log(`  [latency] task run: ${Date.now() - t0} ms`);
    check("pump responded", pump.json?.ok === true);
    const done = (pump.json?.complete ?? []).find((t) => t.id === id);
    check("task moved to complete", !!done, done ? "" : "(not complete)");
    check("result has step summary", !!done?.result?.summary, done?.result?.summary ?? "");
    check("at least one step succeeded", (done?.result?.stepsOk ?? 0) >= 1, `(${done?.result?.stepsOk} ok)`);
    const log = await jreq(base, `/api/tasks/${encodeURIComponent(id)}/log`);
    check("runner log written", typeof log.json?.log === "string" && log.json.log.includes("PLAN"));
    check("log records step execution", /step \d+ \w+/.test(log.json?.log ?? ""));

    // ===== 4. retry logic =====
    console.log("\n=== 4. retry logic (failing step) ===");
    const rc = await jreq(base, "/api/tasks/create", {
      method: "POST",
      body: {
        goal: "Use web_crawl to read the page at http://127.0.0.1:9/unreachable and summarize it.",
        steps: ["web_crawl"],
        priority: "high",
      },
    });
    const rid = rc.json?.task?.id;
    await jreq(base, "/api/tasks/queue", { method: "POST", timeoutMs: 240_000 });
    const rlog = await jreq(base, `/api/tasks/${encodeURIComponent(rid)}/log`);
    const logText = rlog.json?.log ?? "";
    check("retry attempts logged", /attempt 2/.test(logText) || /FAILED after \d+ retries/.test(logText), logText.match(/attempt \d/)?.[0] ?? "");
    // The whole task still completes (never aborts).
    const q2 = await jreq(base, "/api/tasks/queue");
    check("task with failing step still completed (never aborted)", (q2.json?.complete ?? []).some((t) => t.id === rid));

    // ===== 5. morning brief =====
    console.log("\n=== 5. morning brief generation ===");
    const brief = await jreq(base, "/api/tasks/brief", { method: "POST", timeoutMs: 200_000 });
    check("brief generated", brief.json?.ok === true && brief.json?.generated?.ok === true);
    check("brief has content", typeof brief.json?.brief?.content === "string" && brief.json.brief.content.length > 0);
    check("brief reports counts", (brief.json?.generated?.completed ?? -1) >= 0);

    // ===== 6. API shapes =====
    console.log("\n=== 6. API route shapes ===");
    const getBrief = await jreq(base, "/api/tasks/brief");
    check("GET brief shape", getBrief.json?.ok === true && "brief" in getBrief.json);
    check("scheduler status present", !!q2.json?.scheduler && typeof q2.json.scheduler.briefTime === "string");
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try {
    fs.rmSync(tasksDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log("\n[cleanup] removed runtime tasks/ dir");
}

console.log(`\nsmoke-tasks: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
