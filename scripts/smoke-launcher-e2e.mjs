#!/usr/bin/env node
// smoke-launcher-e2e.mjs
//
// End-to-end real launcher cold-start measurement on alt ports
// (11436 / 7800) so the host's tray ollama on 11434 is undisturbed.
//
// Generates a test variant of launcher.bat with the alt ports baked
// in, runs it via cmd.exe from Node (the same non-interactive parent
// stdin context that exercised the < NUL fix in Phase C/E), and
// captures wall-clock timings:
//
//   t0  : spawn launcher.bat
//   t1  : ollama bound on 11436 (curl /api/tags returns 200)
//   t2  : next start bound on 7800 (curl / returns 200)
//   t3  : first chat token via POST /api/chat
//
// Cleans up child processes via taskkill before exiting. Idempotent:
// safe to re-run; will refuse to start if 11436 or 7800 are held.
//
// Windows-only (launcher.bat). The .command and .sh variants would
// need analogous scripts on their respective platforms.

import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

if (process.platform !== "win32") {
  console.error("smoke-launcher-e2e is Windows-only (uses launcher.bat).");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
const OLLAMA_PORT = 11436;
const NEXT_PORT = 7800;
const OLLAMA_URL = `http://127.0.0.1:${OLLAMA_PORT}`;
const NEXT_URL = `http://127.0.0.1:${NEXT_PORT}`;
const TEST_DIR = path.join(os.tmpdir(), "argos-launcher-e2e");
const TEST_BAT = path.join(TEST_DIR, "launcher-altport.bat");

function checkPortFree(port) {
  const r = spawnSync("cmd", ["/c", `netstat -ano | findstr :${port} | findstr LISTENING`], {
    encoding: "utf8",
  });
  return !r.stdout || r.stdout.trim().length === 0;
}

async function pollUntil(label, predicate, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    if (await predicate()) {
      const ms = Date.now() - t0;
      return ms;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
    }
    await sleep(500);
  }
}

async function tryFetch(url, timeoutMs = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status >= 200 && r.status < 500;
  } catch {
    return false;
  }
}

// -------------------- prep ----------------------
console.log(`smoke-launcher-e2e — real launcher.bat cold-start on alt ports`);
console.log(`  OLLAMA_PORT  ${OLLAMA_PORT}`);
console.log(`  NEXT_PORT    ${NEXT_PORT}`);
console.log("");

if (!checkPortFree(OLLAMA_PORT)) {
  console.error(`[FAIL] port ${OLLAMA_PORT} is in use. Free it before running this smoke.`);
  process.exit(1);
}
if (!checkPortFree(NEXT_PORT)) {
  console.error(`[FAIL] port ${NEXT_PORT} is in use. Free it before running this smoke.`);
  process.exit(1);
}
console.log(`[ok] both ports free`);

// -------------------- generate alt-port launcher.bat -----------
mkdirSync(TEST_DIR, { recursive: true });
const launcherSrc = readFileSync(path.join(ROOT, "launchers", "launcher.bat"), "utf8");
const altBat = launcherSrc
  .replace(/127\.0\.0\.1:11434/g, `127.0.0.1:${OLLAMA_PORT}`)
  .replace(/-p 7799/g, `-p ${NEXT_PORT}`)
  .replace(/:11434/g, `:${OLLAMA_PORT}`)
  .replace(/:7799/g, `:${NEXT_PORT}`)
  .replace(/ARGOS-OLLAMA/g, "ARGOS-OLLAMA-E2E")
  .replace(/ARGOS-NEXT/g, "ARGOS-NEXT-E2E")
  // The auto-open-browser step is annoying for a smoke run.
  .replace(/^start "" http:\/\/.*$/m, "REM start (smoke: browser-open disabled)")
  // The interactive `pause >NUL` waits for a keypress; the smoke
  // is non-interactive. Replace with a sleep — the smoke's cleanup
  // will taskkill the launcher before this elapses.
  // CRITICAL: do NOT just delete the pause — the next line is
  // `:CLEANUP` which kills the daemons, so we'd never get to poll.
  // Why ping instead of `timeout`: timeout reads stdin to detect
  // keypresses and errors out when stdin is a closed pipe (which it
  // is under start /B from Node's spawnSync). ping doesn't touch
  // stdin and just runs for N seconds.
  .replace(/pause >NUL\r?\n/g, "ping -n 600 127.0.0.1 >NUL\r\n");

writeFileSync(TEST_BAT, altBat, { encoding: "utf8" });
console.log(`[ok] generated alt-port launcher at ${TEST_BAT}`);

// Critical: the test launcher must read THIS repo's app/, not the PNY
// payload. We point ARGOS_ROOT explicitly via env so the layout-sniff
// logic resolves to the source repo.
const repoEnv = {
  ...process.env,
  // launcher.bat's layout-sniff falls through to PARENT_DIR\package.json
  // if SCRIPT_DIR\package.json exists. We put the test bat in a temp
  // dir with no package.json, then the launcher walks up to TEST_DIR's
  // parent... which is also wrong. Workaround: point at repo via the
  // env-var shortcut we'll add below.
};
// We don't have an env-shortcut today; the test bat lives in tempdir
// which doesn't have package.json. So instead we'll COPY the bat into
// the repo root for the duration of the smoke and delete it after.
const ROOT_BAT = path.join(ROOT, "launcher-e2e-smoke.bat");
writeFileSync(ROOT_BAT, altBat, { encoding: "utf8" });
console.log(`[ok] staged at ${ROOT_BAT}`);

// -------------------- kick off launcher ------------------
const startedAt = Date.now();
console.log(`\n[t0=${startedAt}] kicking off launcher...`);
// Launch via PowerShell Start-Process — we've proven this works for
// spawning daemons under non-interactive Node parents (Phase C).
// `start` cmd builtin + cmd /c spawnSync hangs; spawn() + detached
// doesn't actually launch the bat (probably because batch files need a
// real console). Start-Process gives the bat its own console + own
// stdio + own process tree, fully decoupled from this Node process.
// Pass the bat by FULL PATH. -WorkingDirectory fails silently in some
// sandbox/non-interactive PowerShell contexts (Start-Process succeeds
// but the spawned cmd never enters the requested cwd, so the bat
// can't find launcher-e2e-smoke.bat). Full path bypasses the wd
// issue. The launcher.bat's own layout-sniff uses %~dp0 so it figures
// out its own ARGOS_ROOT regardless of caller cwd.
const psCmd = `Start-Process -FilePath cmd -ArgumentList '/c','${ROOT_BAT}' -WindowStyle Minimized`;
const launchProc = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", psCmd],
  { encoding: "utf8", env: repoEnv }
);
if (launchProc.status !== 0) {
  console.log(`[launchProc] Start-Process exit=${launchProc.status}`);
  if (launchProc.stderr) console.log(`[launchProc stderr] ${launchProc.stderr.slice(0, 300)}`);
}

let exitCode = 0;
const cleanup = async (reason = "") => {
  console.log(`\n[cleanup] ${reason}`);
  // Kill the launcher + spawned daemons by window title
  spawnSync("taskkill", ["/F", "/FI", "WINDOWTITLE eq ARGOS-NEXT-E2E*"], { stdio: "ignore" });
  spawnSync("taskkill", ["/F", "/FI", "WINDOWTITLE eq ARGOS-OLLAMA-E2E*"], { stdio: "ignore" });
  // Also kill any orphan ollama serving on our test port. CommandLine
  // filter on Windows requires wmic / CIM; just kill any non-system
  // ollama that's listening on OLLAMA_PORT.
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${OLLAMA_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    ],
    { encoding: "utf8" }
  );
  if (ps.stderr && ps.stderr.length > 0) {
    console.log(`  cleanup PS stderr: ${ps.stderr.trim().slice(0, 200)}`);
  }
  // Same for next.js test port
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${NEXT_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    ],
    { encoding: "utf8" }
  );
  if (existsSync(ROOT_BAT)) unlinkSync(ROOT_BAT);
  await sleep(500);
};

process.on("SIGINT", () => cleanup("SIGINT").then(() => process.exit(130)));
process.on("SIGTERM", () => cleanup("SIGTERM").then(() => process.exit(143)));

try {
  // -------------------- t1: ollama ready -------------------
  console.log(`[t0+0] waiting for ollama on ${OLLAMA_URL}/api/tags...`);
  const ollamaMs = await pollUntil(
    "ollama",
    () => tryFetch(`${OLLAMA_URL}/api/tags`),
    60_000
  );
  console.log(`[t1=${ollamaMs}ms] ollama ready`);

  // -------------------- t2: next ready ---------------------
  console.log(`[t1+] waiting for next on ${NEXT_URL}/...`);
  const nextMs = await pollUntil(
    "next",
    () => tryFetch(`${NEXT_URL}/`),
    120_000
  );
  const t2 = ollamaMs + nextMs;
  console.log(`[t2=${t2}ms] next ready (next: ${nextMs}ms after ollama)`);

  // -------------------- t3: first chat token ---------------
  console.log(`[t2+] sending chat request to ${NEXT_URL}/api/chat...`);
  const chatT0 = Date.now();
  const chatRes = await fetch(`${NEXT_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "say hi in one word" }],
      personaId: "bartimaeus",
      model: "llama3.1:8b-instruct-q4_K_M",
    }),
  });
  if (!chatRes.ok) {
    throw new Error(`chat returned ${chatRes.status}: ${(await chatRes.text()).slice(0, 200)}`);
  }
  const reader = chatRes.body.getReader();
  let firstByteMs = null;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === null) firstByteMs = Date.now() - chatT0;
    const text = decoder.decode(value);
    if (text.includes('"content":"') && text.includes('"role":"assistant"')) break;
  }
  reader.cancel().catch(() => {});
  const t3Total = ollamaMs + nextMs + firstByteMs;
  console.log(`[t3=${t3Total}ms] first chat token (chat TTFB: ${firstByteMs}ms)`);

  // -------------------- report ------------------------
  console.log("");
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  REAL LAUNCHER E2E TIMINGS (cold)");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  Ollama bound on :${OLLAMA_PORT}:        ${ollamaMs} ms`);
  console.log(`  Next bound on :${NEXT_PORT}:           ${nextMs} ms (delta)`);
  console.log(`  Chat first token (TTFB):       ${firstByteMs} ms (delta)`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  TOTAL kickoff → first token:   ${t3Total} ms`);
  console.log("════════════════════════════════════════════════════════════════");

  exitCode = 0;
} catch (e) {
  console.error(`\n[FAIL] ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup("done");
}

process.exit(exitCode);
