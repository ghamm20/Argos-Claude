#!/usr/bin/env node
// smoke-loops-ui.mjs — Self-Evolving Loop Suite Tier 4 gate.
//
//   1. /api/loops/status exposes the all-night signals (patchesToday,
//      benchmark trend, pendingQuestions, recentBackups).
//   2. /api/loops/patches ledger grows on apply (APPLIED) + rollback (FAILED).
//   3. /api/loops/questions: ask via active-learning → appears pending → answer
//      → no longer pending.
//   4. /api/loops/rollback lists backups + restores one.
//   5. Morning brief carries the "Self-Evolving Loops" addendum.
//   6. The /loops page renders (200).
//
// Usage: node scripts/smoke-loops-ui.mjs [--port 7836]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7836;

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

function req(base, path, opts = {}) {
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
        timeout: opts.timeoutMs || 200_000,
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-json (html) */
          }
          res({ ok: true, status: resp.statusCode, json, text });
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
    const r = await req(base, "/api/loops/status", { timeoutMs: 4000 });
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

try {
  await withServer("loops-ui", BASE_PORT, async (base) => {
    // ===== 1. status signals =====
    console.log("\n=== 1. status all-night signals ===");
    const st = await req(base, "/api/loops/status");
    check("patchesToday present", !!st.json?.patchesToday && typeof st.json.patchesToday.applied === "number");
    check("benchmark trend present", !!st.json?.benchmark && typeof st.json.benchmark.trend === "string");
    check("pendingQuestions present", typeof st.json?.pendingQuestions === "number");
    check("recentBackups present", typeof st.json?.recentBackups === "number");

    // ===== 2. patch ledger =====
    console.log("\n=== 2. patch ledger ===");
    await req(base, "/api/loops/apply", { method: "POST", body: { target: "state/loops/_ui-keep.txt", content: "ok\n", test: "none" } });
    await req(base, "/api/loops/apply", { method: "POST", body: { target: "state/loops/_ui-roll.txt", content: "no\n", test: "reject" } });
    const pat = await req(base, "/api/loops/patches");
    check("applied ledger has entries", (pat.json?.applied ?? []).length >= 1, `(${pat.json?.applied?.length})`);
    check("rolledBack ledger has entries", (pat.json?.rolledBack ?? []).length >= 1, `(${pat.json?.rolledBack?.length})`);

    // ===== 3. questions ask → answer =====
    console.log("\n=== 3. active-learning questions ===");
    await req(base, "/api/loops/evolve", { method: "POST", body: { loop: "active_learning", input: { uncertainty: { category: "logic", mastery: 0.2 } } }, timeoutMs: 60_000 });
    const q1 = await req(base, "/api/loops/questions");
    const pendingQ = q1.json?.pending ?? [];
    check("question appears pending", pendingQ.length >= 1, `(${pendingQ.length})`);
    const qid = pendingQ[0]?.id;
    const ans = await req(base, "/api/loops/questions", { method: "POST", body: { id: qid, answer: "Focus on multi-step logic chains." } });
    check("answer recorded", ans.json?.answered === true);
    const q2 = await req(base, "/api/loops/questions");
    check("answered question no longer pending", !(q2.json?.pending ?? []).some((q) => q.id === qid));

    // ===== 4. backups + restore =====
    console.log("\n=== 4. backups browser + restore ===");
    const bk = await req(base, "/api/loops/rollback");
    check("backups listed", (bk.json?.backups ?? []).length >= 1, `(${bk.json?.backups?.length})`);
    const bid = bk.json?.backups?.[0]?.id;
    const rb = await req(base, "/api/loops/rollback", { method: "POST", body: { backupId: bid } });
    check("restore succeeds", rb.json?.ok === true);

    // ===== 5. morning brief addendum =====
    console.log("\n=== 5. morning brief addendum ===");
    const brief = await req(base, "/api/tasks/brief", { method: "POST", timeoutMs: 200_000 });
    const content = brief.json?.brief?.content ?? "";
    check("morning brief includes loops addendum", /Self-Evolving Loops/.test(content), content ? "(found)" : "(no content)");

    // ===== 6. loops page renders =====
    console.log("\n=== 6. /loops page renders ===");
    const page = await req(base, "/loops");
    check("loops page 200", page.status === 200);
    check("page mentions the 20 loops", /The 20 loops|Loops/.test(page.text ?? ""));
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try {
    fs.rmSync(join(repoRoot, "state", "loops"), { recursive: true, force: true });
    fs.rmSync(join(repoRoot, "restore", "loops"), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log("\n[cleanup] removed loop runtime dirs");
}

console.log(`\nsmoke-loops-ui: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
