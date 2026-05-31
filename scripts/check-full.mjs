#!/usr/bin/env node
// check-full.mjs
//
// Single-command full verification: static checks (lint, typecheck, build,
// verify-argos) followed by the live-server smoke battery (h2 chat, vault
// ingest+search, retrieval+truth-mode, settings persistence, plus the
// static smoke-launcher and audit harnesses).
//
// Spins up `next dev` on a free port, runs each smoke against SMOKE_BASE,
// tears the server down even on failure. Exits non-zero if any stage fails.
//
// Usage:
//   node scripts/check-full.mjs
//
// Env overrides:
//   SMOKE_PORT=3001        use a specific dev-server port (default: 3000)
//   SKIP_LIVE=1            run only the static stages (skip the dev-server smokes)
//   SKIP_STATIC=1          run only the live-server smokes (assume already verified)

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.SMOKE_PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_LIVE = process.env.SKIP_LIVE === "1";
const SKIP_STATIC = process.env.SKIP_STATIC === "1";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
// Windows requires shell:true for .cmd shims; on POSIX, shell:false is fine.
const SHELL = process.platform === "win32";

const t0 = Date.now();
const results = [];
function record(name, ok, ms, detail = "") {
  results.push({ name, ok, ms, detail });
  const tag = ok ? "PASS" : "FAIL";
  const line = `[${tag}] ${name.padEnd(28)} ${`${ms}ms`.padStart(8)}  ${detail}`;
  process.stdout.write(line + "\n");
}

function runStatic(name, cmd, args) {
  const start = Date.now();
  const r = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: SHELL,
  });
  const ms = Date.now() - start;
  const ok = r.status === 0;
  const detail = ok
    ? ""
    : `(exit ${r.status}; tail: ${(r.stderr?.toString() || r.stdout?.toString() || "")
        .trim()
        .split(/\r?\n/)
        .slice(-2)
        .join(" | ")
        .slice(0, 200)})`;
  record(name, ok, ms, detail);
  return ok;
}

async function runStaticLive(name, cmd, args) {
  const start = Date.now();
  const r = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: SHELL,
    env: { ...process.env, SMOKE_BASE: BASE, SMOKE_URL: `${BASE}/api/chat` },
  });
  const ms = Date.now() - start;
  const ok = r.status === 0;
  const detail = ok
    ? ""
    : `(exit ${r.status}; tail: ${(r.stderr?.toString() || r.stdout?.toString() || "")
        .trim()
        .split(/\r?\n/)
        .slice(-2)
        .join(" | ")
        .slice(0, 200)})`;
  record(name, ok, ms, detail);
  return ok;
}

async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return true;
    } catch {
      /* not ready */
    }
    await sleep(1000);
  }
  return false;
}

process.stdout.write(`check-full — argos full verification\n`);
process.stdout.write(`${"─".repeat(64)}\n`);

// ----- Static stages ------------------------------------------------
if (!SKIP_STATIC) {
  process.stdout.write(`STATIC STAGE\n`);
  const okLint = runStatic("lint", NPM, ["run", "lint"]);
  const okTypecheck = runStatic("typecheck", NPM, ["run", "typecheck"]);
  const okBuild = runStatic("build", NPM, ["run", "build"]);
  const okVerify = runStatic("verify-argos", NPM, ["run", "verify"]);
  const okStubAudit = runStatic("audit-stub-honesty", "node", [
    "scripts/audit-stub-honesty.mjs",
  ]);
  const okDepsAudit = runStatic("audit-production-deps", "node", [
    "scripts/audit-production-deps.mjs",
  ]);
  const okLauncher = runStatic("smoke-launcher", "node", [
    "scripts/smoke-launcher.mjs",
  ]);

  if (![okLint, okTypecheck, okBuild, okVerify, okStubAudit, okDepsAudit, okLauncher].every(Boolean)) {
    process.stdout.write(`\nStatic stage FAILED — skipping live stage.\n`);
    summary(1);
  }
}

// ----- Live stages --------------------------------------------------
let devProc = null;
let liveOk = true;

if (!SKIP_LIVE) {
  process.stdout.write(`\nLIVE STAGE (dev server on ${BASE})\n`);
  process.stdout.write(`  spinning up next dev...\n`);

  // shell: SHELL (true on Windows) is required to spawn npm.cmd — Node
  // ≥18.20/20.12+ (and strictly on Node 24) refuse to spawn .cmd/.bat
  // without it (EINVAL). The static stage's spawnSync already passes
  // shell:SHELL; this live spawn was missing it. Latent until 2026-05-31
  // because the static stage always failed first and skipped the live
  // stage — once the static gates went green, this surfaced.
  devProc = spawn(NPM, ["run", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    shell: SHELL,
    env: { ...process.env, PORT: String(PORT) },
  });
  devProc.stdout.on("data", () => {});
  devProc.stderr.on("data", () => {});

  const ready = await waitForServer(60_000);
  if (!ready) {
    record("dev-server-startup", false, 60_000, "(server did not respond on /)");
    liveOk = false;
  } else {
    const t1 = Date.now() - t0;
    process.stdout.write(`  dev server ready (t+${t1}ms)\n`);

    const okH2 = await runStaticLive("smoke-h2 (chat)", "node", [
      "scripts/smoke-h2.mjs",
    ]);
    const okSettings = await runStaticLive("smoke-settings", "node", [
      "scripts/smoke-settings.mjs",
    ]);
    const okVault = await runStaticLive("smoke-vault", "node", [
      "scripts/smoke-vault.mjs",
    ]);
    const okRetrieval = await runStaticLive("smoke-retrieval", "node", [
      "scripts/smoke-retrieval.mjs",
    ]);
    if (!okH2 || !okSettings || !okVault || !okRetrieval) liveOk = false;
  }

  // Tear down the dev server
  if (devProc && !devProc.killed) {
    process.stdout.write(`  tearing down dev server...\n`);
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(devProc.pid)], {
          stdio: "ignore",
        });
      } else {
        devProc.kill("SIGTERM");
        await sleep(2000);
        if (!devProc.killed) devProc.kill("SIGKILL");
      }
    } catch {
      /* best-effort */
    }
  }
}

summary(liveOk ? 0 : 1);

function summary(exitCode) {
  const totalMs = Date.now() - t0;
  process.stdout.write(`\n${"─".repeat(64)}\n`);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(
    `check-full ${exitCode === 0 ? "PASS" : "FAIL"}  ${passed} pass / ${failed} fail  (${totalMs}ms total)\n`
  );
  process.exit(exitCode);
}
