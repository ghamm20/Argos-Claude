#!/usr/bin/env node
// smoke-loops-infra.mjs — Self-Evolving Loop Suite Tier 0 gate.
//
// Verifies the all-night infrastructure deterministically (no model):
//   1. Apply pipeline KEEP: apply behind backup+test("none") → file written.
//   2. Apply pipeline ROLLBACK: apply with test("reject") → auto-rolled back,
//      a created file is removed, an existing file restored byte-for-byte.
//   3. Governance refusal: apply to governance code → refused, never touched.
//   4. Boundary refusal: apply outside ARGOS_ROOT → refused.
//   5. Backup browser + manual rollback route.
//   6. Patch outcome logs written to state/loops/patches/{APPLIED,FAILED}/.
//   7. Enhanced detectGaming: criteria mutation, shortcut pattern, spec
//      divergence (+ an honest control) via /api/loops/evaluate with context.
//   8. Scheduler windows surfaced via /api/loops/status.
//
// Usage: node scripts/smoke-loops-infra.mjs [--port 7832]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7832;

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
        timeout: opts.timeoutMs || 60_000,
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

const keepFile = join(repoRoot, "state", "loops", "_probe-keep.txt");
const rollNew = join(repoRoot, "state", "loops", "_probe-roll-new.txt");
const rollExisting = join(repoRoot, "state", "loops", "_probe-roll-existing.txt");

try {
  // Seed an existing file to verify byte-for-byte restore on rollback.
  fs.mkdirSync(join(repoRoot, "state", "loops"), { recursive: true });
  fs.writeFileSync(rollExisting, "ORIGINAL CONTENT\n", "utf8");

  await withServer("loops-infra", BASE_PORT, async (base) => {
    // ===== 1. apply KEEP =====
    console.log("\n=== 1. apply pipeline — KEEP (test green) ===");
    const keep = await jreq(base, "/api/loops/apply", {
      method: "POST",
      body: { target: "state/loops/_probe-keep.txt", content: "KEPT BY APPLY\n", test: "none", reason: "infra smoke keep" },
    });
    check("apply kept", keep.json?.kept === true && keep.json?.applied === true, keep.json?.reason);
    check("backup id returned", typeof keep.json?.backupId === "string" && keep.json.backupId.length > 0);
    check("kept file written with new content", fs.existsSync(keepFile) && fs.readFileSync(keepFile, "utf8").includes("KEPT BY APPLY"));

    // ===== 2. apply ROLLBACK =====
    console.log("\n=== 2. apply pipeline — ROLLBACK (test red) ===");
    const rollN = await jreq(base, "/api/loops/apply", {
      method: "POST",
      body: { target: "state/loops/_probe-roll-new.txt", content: "SHOULD NOT SURVIVE\n", test: "reject", reason: "infra smoke roll new" },
    });
    check("apply attempted then rolled back", rollN.json?.applied === true && rollN.json?.kept === false && rollN.json?.rolledBack === true, rollN.json?.reason);
    check("created file removed on rollback", !fs.existsSync(rollNew));

    const rollE = await jreq(base, "/api/loops/apply", {
      method: "POST",
      body: { target: "state/loops/_probe-roll-existing.txt", content: "CORRUPTED\n", test: "reject", reason: "infra smoke roll existing" },
    });
    check("existing file rolled back", rollE.json?.rolledBack === true);
    check("existing file restored byte-for-byte", fs.readFileSync(rollExisting, "utf8") === "ORIGINAL CONTENT\n", JSON.stringify(fs.readFileSync(rollExisting, "utf8")));

    // ===== 3. governance refusal =====
    console.log("\n=== 3. governance + boundary refusal ===");
    const gov = await jreq(base, "/api/loops/apply", {
      method: "POST",
      body: { target: "lib/tools/executor.ts", content: "// hacked\n", test: "none", reason: "should be refused" },
    });
    check("governance code apply refused", gov.json?.applied === false && /governance|refused/i.test(gov.json?.reason ?? ""), gov.json?.reason);
    check("governance file untouched", fs.readFileSync(join(repoRoot, "lib", "tools", "executor.ts"), "utf8").includes("governance enforcement point"));

    const oob = await jreq(base, "/api/loops/apply", {
      method: "POST",
      body: { target: "../../escape.txt", content: "x", test: "none", reason: "should be refused" },
    });
    check("out-of-boundary apply refused", oob.json?.applied === false && /boundary|refused/i.test(oob.json?.reason ?? ""), oob.json?.reason);

    // ===== 4. backup browser + rollback route =====
    console.log("\n=== 4. backup browser + manual rollback ===");
    const backups = await jreq(base, "/api/loops/rollback");
    check("backups listed", Array.isArray(backups.json?.backups) && backups.json.backups.length >= 1, `(${backups.json?.backups?.length})`);
    const someId = keep.json?.backupId;
    const restore = await jreq(base, "/api/loops/rollback", { method: "POST", body: { backupId: someId } });
    check("manual rollback restores from backup", restore.json?.ok === true, restore.json?.reason);
    // The keep file existed=false at backup time → manual rollback removes it.
    check("keep-file removed by its backup rollback", !fs.existsSync(keepFile));

    // ===== 5. patch outcome logs =====
    console.log("\n=== 5. patch outcome logs ===");
    const day = new Date().toISOString().slice(0, 10);
    const appliedDir = join(repoRoot, "state", "loops", "patches", "APPLIED", day);
    const failedDir = join(repoRoot, "state", "loops", "patches", "FAILED", day);
    check("APPLIED log written", fs.existsSync(appliedDir) && fs.readdirSync(appliedDir).length >= 1);
    check("FAILED log written", fs.existsSync(failedDir) && fs.readdirSync(failedDir).length >= 1);

    // ===== 6. enhanced detectGaming via context =====
    console.log("\n=== 6. enhanced detectGaming heuristics ===");
    const baseResult = {
      loopId: "evolutionary", loopNumber: 5, ok: true, summary: "x",
      claimedImprovement: true, claimedScore: 0.9, benchmarkBefore: null, benchmarkAfter: null,
      evidence: [{ kind: "comparison", ref: "c" }], proposals: [],
    };
    const criteriaMut = await jreq(base, "/api/loops/evaluate", {
      method: "POST",
      body: { result: baseResult, context: { priorSpec: "answer correctly", currentSpec: "answer quickly" } },
    });
    check("criteria mutation → gaming", criteriaMut.json?.evaluation?.gamingDetected === true, criteriaMut.json?.evaluation?.gamingReasons?.find((r) => /goalpost|criteria/i.test(r)) ?? "");

    const shortcut = await jreq(base, "/api/loops/evaluate", {
      method: "POST",
      body: { result: baseResult, context: { recentOutputs: ["same", "same", "same", "same"] } },
    });
    check("shortcut pattern → gaming", shortcut.json?.evaluation?.gamingDetected === true, shortcut.json?.evaluation?.gamingReasons?.find((r) => /shortcut/i.test(r)) ?? "");

    const specDiv = await jreq(base, "/api/loops/evaluate", {
      method: "POST",
      body: { result: baseResult, context: { priorScore: 0.5, outputMatchesSpec: false } },
    });
    check("spec divergence → gaming", specDiv.json?.evaluation?.gamingDetected === true, specDiv.json?.evaluation?.gamingReasons?.find((r) => /diverged|spec/i.test(r)) ?? "");

    const honest = await jreq(base, "/api/loops/evaluate", {
      method: "POST",
      body: {
        result: { ...baseResult, benchmarkBefore: 0.6, benchmarkAfter: 0.7, evidence: [{ kind: "benchmark", ref: "reason-1", before: 0.6, after: 0.7 }] },
        context: { priorSpec: "answer correctly", currentSpec: "answer correctly", recentOutputs: ["a", "b", "c"], priorScore: 0.6, outputMatchesSpec: true },
      },
    });
    check("honest run with context NOT gaming", honest.json?.evaluation?.gamingDetected === false, honest.json?.evaluation?.gamingReasons?.join("; ") ?? "");

    // ===== 7. scheduler windows =====
    console.log("\n=== 7. scheduled loop windows ===");
    const status = await jreq(base, "/api/loops/status");
    const windows = status.json?.scheduler?.windows ?? [];
    check("scheduler exposes windows", Array.isArray(windows) && windows.length >= 4, `(${windows.length})`);
    check("nightly + weekly windows registered", windows.some((w) => /2AM/i.test(w.label)) && windows.some((w) => /Sunday|Friday|Saturday/i.test(w.label)));
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
  console.log("\n[cleanup] removed state/loops + restore/loops");
}

console.log(`\nsmoke-loops-infra: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
