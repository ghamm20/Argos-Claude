#!/usr/bin/env node
// demo-check.mjs
//
// Single-command pre-demo sanity check. Verifies the demo path is
// healthy WITHOUT requiring a dev server (uses Ollama daemon directly
// + reads disk state). Designed to run in <30s.
//
// Stages:
//   1. Static verify-argos (Seven Rules)
//   2. Ollama daemon reachable + responding to /api/tags
//   3. Required models present (llama3.1:8b + nomic-embed-text)
//   4. Warm models (chat + embed) so first demo hit is sub-second
//   5. Production build artifacts present (.next/ exists, BUILD_ID readable)
//   6. Launcher binary lookup succeeds (bundled / system / PATH)
//
// Designed for: operator runs this 30s before walking into a demo.
// Single PASS/FAIL with actionable detail on any failure.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = process.platform === "win32";

function ollamaBase() {
  const raw = process.env.OLLAMA_HOST;
  if (!raw) return "http://127.0.0.1:11434";
  const trimmed = raw.trim();
  if (!trimmed) return "http://127.0.0.1:11434";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
  return `http://${trimmed}`.replace(/\/$/, "");
}

const BASE = ollamaBase();
const t0 = Date.now();
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  const padded = name.padEnd(36);
  process.stdout.write(`[${tag}] ${padded}  ${detail}\n`);
}

process.stdout.write(`demo-check — pre-demo sanity check\n`);
process.stdout.write(`${"─".repeat(60)}\n`);

// ----- Stage 1: verify-argos ---------------------------------------
{
  // Invoke verify-argos directly instead of via `npm run verify` —
  // spawning npm via shell:true on Windows gets noisy with the
  // DeprecationWarning + exit-code semantics, and we don't need the
  // npm overhead for a single-script call.
  const r = spawnSync(process.execPath, ["scripts/verify-argos.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const ok = r.status === 0;
  const detail = ok
    ? "7/7 rule groups"
    : `(exit ${r.status}) ${(r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-1)[0]}`;
  record("Seven Rules verify-argos", ok, detail);
}

// ----- Stage 2: Ollama daemon reachable ----------------------------
let daemonOk = false;
{
  let tags = null;
  try {
    const r = await fetch(`${BASE}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      tags = await r.json();
      daemonOk = true;
    }
  } catch {
    /* daemon down */
  }
  if (daemonOk) {
    const modelCount = tags?.models?.length ?? 0;
    record(`Ollama daemon (${BASE})`, true, `${modelCount} models installed`);
  } else {
    record(`Ollama daemon (${BASE})`, false, "not reachable — run `ollama serve` or launcher.bat");
  }
}

// ----- Stage 3: required models present ----------------------------
const requiredModels = [
  process.env.WARM_CHAT_MODEL || "llama3.1:8b-instruct-q4_K_M",
  process.env.WARM_EMBED_MODEL || "nomic-embed-text",
];
let modelsPresent = false;
if (daemonOk) {
  try {
    const r = await fetch(`${BASE}/api/tags`);
    const j = await r.json();
    const installed = new Set((j.models || []).map((m) => m.name || m.model));
    function findMatching(target) {
      if (installed.has(target)) return target;
      const base = target.split(":")[0];
      for (const name of installed) {
        if (name.startsWith(`${target}:`) || name === base || name.startsWith(`${base}:`)) {
          return name;
        }
      }
      return null;
    }
    const missing = [];
    for (const m of requiredModels) {
      if (!findMatching(m)) missing.push(m);
    }
    modelsPresent = missing.length === 0;
    record(
      "Required models present",
      modelsPresent,
      modelsPresent ? requiredModels.join(", ") : `missing: ${missing.join(", ")} — pull with: ollama pull ${missing.join(" ; ollama pull ")}`
    );
  } catch (e) {
    record("Required models present", false, `lookup failed: ${e.message}`);
  }
} else {
  record("Required models present", false, "(skipped — daemon not reachable)");
}

// ----- Stage 4: warm models ----------------------------------------
let warmOk = false;
if (modelsPresent) {
  const tWarm0 = Date.now();
  try {
    // Quick warm: chat model + embed model in parallel
    const [chatRes, embedRes] = await Promise.all([
      fetch(`${BASE}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: requiredModels[0],
          prompt: "hi",
          stream: false,
          options: { num_predict: 1 },
        }),
        signal: AbortSignal.timeout(120_000),
      }),
      fetch(`${BASE}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: requiredModels[1], prompt: "warm" }),
        signal: AbortSignal.timeout(60_000),
      }),
    ]);
    const tWarm = Date.now() - tWarm0;
    warmOk = chatRes.ok && embedRes.ok;
    record(
      "Models warmed (chat + embed)",
      warmOk,
      warmOk
        ? `${tWarm}ms — first demo chat will be sub-second`
        : `chat=${chatRes.status} embed=${embedRes.status}`
    );
  } catch (e) {
    record("Models warmed (chat + embed)", false, e.message);
  }
} else {
  record("Models warmed (chat + embed)", false, "(skipped — models missing)");
}

// ----- Stage 5: production build artifacts -------------------------
{
  const nextDir = path.join(ROOT, ".next");
  const buildIdPath = path.join(nextDir, "BUILD_ID");
  const hasNext = existsSync(nextDir);
  const hasBuildId = existsSync(buildIdPath);
  let buildId = "(none)";
  if (hasBuildId) {
    try {
      buildId = readFileSync(buildIdPath, "utf8").trim();
    } catch {
      /* skip */
    }
  }
  const ok = hasNext && hasBuildId;
  record(
    "Production .next build present",
    ok,
    ok ? `BUILD_ID=${buildId}` : "run `npm run build` first"
  );
}

// ----- Stage 6: launcher binary lookup -----------------------------
if (process.platform === "win32") {
  // Three lookup paths match the launcher.bat resolution order:
  //   1. ARGOS_ROOT\bin\ollama.exe (bundled with USB payload)
  //   2. %LOCALAPPDATA%\Programs\Ollama\ollama.exe (winget install)
  //   3. `where ollama` on PATH
  // No drive letters hardcoded here (Rule 1 — drive letter is
  // operator-dependent; we read ARGOS_ROOT from env, falling back to
  // PATH/system lookup only).
  const bundledCandidate = process.env.ARGOS_ROOT
    ? path.join(process.env.ARGOS_ROOT, "bin", "ollama.exe")
    : null;
  const sysOllama = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "Ollama",
    "ollama.exe"
  );
  const haveBundled = bundledCandidate ? existsSync(bundledCandidate) : false;
  const haveSystem = existsSync(sysOllama);
  const whereR = spawnSync("where", ["ollama"], { encoding: "utf8" });
  const havePath = whereR.status === 0 && whereR.stdout?.trim().length > 0;
  const ok = haveBundled || haveSystem || havePath;
  let source = "none";
  if (haveBundled) source = `bundled (${bundledCandidate})`;
  else if (haveSystem) source = `system (${sysOllama})`;
  else if (havePath) source = `PATH (${whereR.stdout.trim().split(/\r?\n/)[0]})`;
  else if (!process.env.ARGOS_ROOT)
    source = "none — set ARGOS_ROOT env to point at the USB ARGOS dir, or install Ollama";
  record("Launcher Ollama resolution", ok, source);
} else {
  record("Launcher Ollama resolution", true, "(skipped — non-Windows)");
}

// ----- Summary -----------------------------------------------------
const totalMs = Date.now() - t0;
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${"─".repeat(60)}\n`);
process.stdout.write(
  `demo-check ${failed === 0 ? "PASS" : "FAIL"}  ${passed} pass / ${failed} fail  (${totalMs}ms total)\n`
);
if (failed === 0) {
  process.stdout.write(
    "\n  ✓ Ready to demo. First chat will be sub-second.\n"
  );
} else {
  process.stdout.write("\n  ✗ Fix failures above before demo.\n");
}
process.exit(failed === 0 ? 0 : 1);
