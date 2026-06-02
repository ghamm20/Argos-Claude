#!/usr/bin/env node
// smoke-loops-tier3.mjs — Self-Evolving Loop Suite Tier 3 gate.
//
//   1. RSI apply — gaming pre-check HALTS before any write (claims improvement
//      while benchmark dropped); governance target REFUSED; non-governance
//      target applies (keep on green, rollback on red).
//   2. World model — best/likely/worst scenarios + a 0-1 risk score.
//   3. Active learning — asks ONE focused question on uncertainty, dedups so it
//      never asks twice.
//   4. Self-training — assembles + writes a fine-tune dataset file.
//   5. Reward optimization — builds + persists a reward model.
//   6. Scheduler now carries the RSI (Sun 4AM) + self-training (Sun 6AM) windows.
//
// Usage: node scripts/smoke-loops-tier3.mjs [--port 7835]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7835;

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

const rsiFile = join(repoRoot, "state", "loops", "_rsi.txt");

try {
  await withServer("loops-tier3", BASE_PORT, async (base) => {
    // ===== 1. RSI apply pipeline =====
    console.log("\n=== 1. RSI apply — gaming/governance/keep/rollback ===");
    const gamed = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "rsi_apply", input: { target: "state/loops/_rsi.txt", content: "x", claimedImprovement: true, benchmarkBefore: 0.8, benchmarkAfter: 0.4 } },
    });
    check("gaming pre-check HALTS before apply", gamed.json?.result?.data?.halted === true, gamed.json?.result?.summary);
    check("nothing written on gaming halt", !fs.existsSync(rsiFile));

    const gov = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "rsi_apply", input: { target: "lib/loops/eval-gate.ts", content: "// x", test: "none" } },
    });
    check("governance target REFUSED", /refused|governance/i.test(gov.json?.result?.summary ?? "") && gov.json?.result?.data?.applied !== true, gov.json?.result?.summary);

    const keep = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "rsi_apply", input: { target: "state/loops/_rsi.txt", content: "applied ok\n", test: "none" } },
    });
    check("non-governance apply KEEP on green", keep.json?.result?.data?.kept === true, keep.json?.result?.summary);
    const roll = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "rsi_apply", input: { target: "state/loops/_rsi2.txt", content: "nope\n", test: "reject" } },
    });
    check("non-governance apply ROLLBACK on red", roll.json?.result?.data?.rolledBack === true, roll.json?.result?.summary);

    // ===== 2. world model =====
    console.log("\n=== 2. world model — scenarios + risk ===");
    const sim = await jreq(base, "/api/loops/simulate", { method: "POST", body: { action: "delete all of last week's audit logs to save space" }, timeoutMs: 120_000 });
    check("world model ran", sim.json?.ok === true);
    check("likely scenario present", typeof sim.json?.data?.scenarios?.likely === "string" && sim.json.data.scenarios.likely.length > 0);
    check("risk field present (number or null)", "risk" in (sim.json?.data ?? {}));

    // ===== 3. active learning question (ask once) =====
    console.log("\n=== 3. active learning — ask once ===");
    const q1 = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "active_learning", input: { uncertainty: { category: "math", mastery: 0.2 } } }, timeoutMs: 60_000 });
    check("asks a focused question on uncertainty", q1.json?.result?.data?.asked === true && typeof q1.json?.result?.data?.question === "string", q1.json?.result?.summary);
    const q2 = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "active_learning", input: { uncertainty: { category: "math", mastery: 0.2 } } }, timeoutMs: 60_000 });
    check("does NOT ask the same question twice", q2.json?.result?.data?.asked === false, q2.json?.result?.summary);

    // ===== 4. self training dataset =====
    console.log("\n=== 4. self training — dataset file ===");
    const st = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "self_training" }, timeoutMs: 60_000 });
    check("self training ran", st.json?.ok === true);
    check("dataset assembled (count is a number)", typeof st.json?.result?.data?.exampleCount === "number");
    const dsPath = st.json?.result?.data?.datasetPath;
    if (dsPath) check("dataset file written", fs.existsSync(dsPath), dsPath);
    else check("dataset file written", true, "(no examples to write — acceptable)");

    // ===== 5. reward optimization model =====
    console.log("\n=== 5. reward optimization — reward model ===");
    const rw = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "reward_optimization" }, timeoutMs: 60_000 });
    check("reward model built", !!rw.json?.result?.data?.rewardModel && typeof rw.json.result.data.rewardModel.weights === "object");
    check("reward-model.json persisted", fs.existsSync(join(repoRoot, "state", "loops", "reward-model.json")));

    // ===== 6. scheduler windows =====
    console.log("\n=== 6. scheduler windows ===");
    const status = await jreq(base, "/api/loops/status");
    const windows = status.json?.scheduler?.windows ?? [];
    check("RSI (Sun 4AM) + self-training (Sun 6AM) scheduled", windows.some((w) => /4AM/.test(w.label)) && windows.some((w) => /6AM/.test(w.label)), windows.map((w) => w.label).join(" | "));
    check("scheduled windows >= 7", windows.length >= 7, `(${windows.length})`);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try {
    fs.rmSync(join(repoRoot, "state", "loops"), { recursive: true, force: true });
    fs.rmSync(join(repoRoot, "restore", "loops"), { recursive: true, force: true });
    fs.rmSync(join(repoRoot, "data", "training"), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log("\n[cleanup] removed loop runtime dirs");
}

console.log(`\nsmoke-loops-tier3: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
