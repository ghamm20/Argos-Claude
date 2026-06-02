#!/usr/bin/env node
// smoke-loops-tier2.mjs — Self-Evolving Loop Suite Tier 2 gate.
//
//   1. Codebase rewrite — autonomous apply: KEEP on green test, ROLLBACK on red,
//      governance target REFUSED, no-target → proposal report, propose-only mode.
//   2. Curriculum mastery: >0.85 advances a topic level; <0.3 for 5 runs marks
//      it stuck (deterministic via a byCategory override).
//   3. Red/Blue team: writes a dated report file; exposes a critical flag.
//   4. Multi-agent debate: builder→critic→verifier→judge roles all present;
//      auto-trigger detection fires on incident/threat topics.
//
// Usage: node scripts/smoke-loops-tier2.mjs [--port 7834]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7834;

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

const cr1 = join(repoRoot, "state", "loops", "_cr.txt");
const cr2 = join(repoRoot, "state", "loops", "_cr2.txt");

try {
  await withServer("loops-tier2", BASE_PORT, async (base) => {
    // ===== 1. codebase rewrite autonomous apply =====
    console.log("\n=== 1. codebase rewrite — autonomous apply ===");
    const keep = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "codebase_rewrite", input: { target: "state/loops/_cr.txt", content: "hello world\n", apply: true, test: "none" } },
    });
    check("apply KEEP on green test", keep.json?.result?.data?.kept === true, keep.json?.result?.summary);
    check("kept file written", fs.existsSync(cr1) && fs.readFileSync(cr1, "utf8").includes("hello world"));

    const roll = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "codebase_rewrite", input: { target: "state/loops/_cr2.txt", content: "bye\n", apply: true, test: "reject" } },
    });
    check("apply ROLLBACK on red test", roll.json?.result?.data?.rolledBack === true, roll.json?.result?.summary);
    check("rolled-back file removed", !fs.existsSync(cr2));

    const gov = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "codebase_rewrite", input: { target: "lib/loops/eval-gate.ts", content: "// hacked\n", apply: true } },
    });
    check("governance target REFUSED", gov.json?.result?.data?.refused === true && /REFUSED|governance/i.test(gov.json?.result?.summary ?? ""), gov.json?.result?.summary);
    check("eval-gate untouched", fs.readFileSync(join(repoRoot, "lib", "loops", "eval-gate.ts"), "utf8").includes("THE EVAL GATE"));

    const report = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "codebase_rewrite", input: {} }, timeoutMs: 60_000 });
    check("no-target → proposal report", typeof report.json?.result?.data?.reportPath === "string" && fs.existsSync(report.json.result.data.reportPath));

    const propose = await jreq(base, "/api/loops/evolve", {
      method: "POST",
      body: { loop: "codebase_rewrite", input: { target: "state/loops/_cr3.txt", content: "export const x = 1;\n" } },
    });
    check("propose-only emits a patch proposal", (propose.json?.result?.proposals ?? []).some((p) => p.kind === "patch") && propose.json?.result?.data?.mode === "propose");

    // ===== 2. curriculum mastery tracking =====
    console.log("\n=== 2. curriculum mastery tracking ===");
    const adv = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "curriculum", input: { byCategory: { reasoning: 0.9 } } } });
    check("mastery > 0.85 advances topic", (adv.json?.result?.data?.advanced ?? []).includes("reasoning") && (adv.json?.result?.data?.progress?.reasoning?.level ?? 0) >= 2, `level=${adv.json?.result?.data?.progress?.reasoning?.level}`);
    let stuckHit = false;
    for (let i = 0; i < 5; i++) {
      const s = await jreq(base, "/api/loops/evolve", { method: "POST", body: { loop: "curriculum", input: { byCategory: { math: 0.1 } } } });
      stuckHit = (s.json?.result?.data?.stuck ?? []).includes("math");
    }
    check("mastery < 0.3 for 5 runs → stuck", stuckHit);

    // ===== 3. red/blue team =====
    console.log("\n=== 3. red/blue team ===");
    const rb = await jreq(base, "/api/loops/redteam", { method: "POST", body: { target: "the operator PIN is reused across systems" }, timeoutMs: 120_000 });
    check("red/blue ran", rb.json?.ok === true);
    check("red/blue report written", typeof rb.json?.data?.reportPath === "string" && fs.existsSync(rb.json.data.reportPath));
    check("critical flag exposed", typeof rb.json?.data?.critical === "boolean");

    // ===== 4. multi-agent debate (4 roles) =====
    console.log("\n=== 4. multi-agent debate ===");
    const deb = await jreq(base, "/api/loops/debate", { method: "POST", body: { topic: "should we treat this as a security incident" }, timeoutMs: 180_000 });
    const roles = deb.json?.data?.roles ?? {};
    check("builder→critic→verifier→judge all present", ["builder", "critic", "verifier", "judge"].every((r) => typeof roles[r] === "string" && roles[r].length > 0), Object.keys(roles).join(","));
    check("auto-trigger fires on incident topic", deb.json?.data?.autoTriggered === true);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try {
    fs.rmSync(join(repoRoot, "state", "loops"), { recursive: true, force: true });
    fs.rmSync(join(repoRoot, "restore", "loops"), { recursive: true, force: true });
    fs.rmSync(join(repoRoot, "data", "curriculum"), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log("\n[cleanup] removed loop runtime dirs");
}

console.log(`\nsmoke-loops-tier2: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
