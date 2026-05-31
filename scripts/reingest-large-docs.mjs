#!/usr/bin/env node
// reingest-large-docs.mjs — Vault long-form fix (2026-05-28).
//
// Spawns a Next.js server pointed at a chosen ARGOS_ROOT (defaults
// to the deployed payload), POSTs /api/vault/reingest with the
// minByteSize=500000 selector, prints chunk-count deltas, shuts
// down. Idempotent — re-running it just re-chunks the same docs
// (chunk counts will be identical the second time since the
// chunker preset hasn't moved).
//
// Re-embedding is expensive: each chunk costs ~1s on the 3060 Ti
// rig. The trilogy is ~1700 chunks total → ~30 minutes. The route
// has maxDuration: 1800 set; this script doesn't have its own
// timeout, it just waits.
//
// Usage:
//   node scripts/reingest-large-docs.mjs                 # defaults to $ARGOS_ROOT or cwd
//   node scripts/reingest-large-docs.mjs --argos-root "<your ARGOS_ROOT>"
//   node scripts/reingest-large-docs.mjs --port 7792
//   node scripts/reingest-large-docs.mjs --min-bytes 1000000   # only ≥1MB

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  return fallback;
}

const PORT = parseInt(flag("--port", "7792"), 10);
// Default to the env-provided ARGOS_ROOT (or cwd) instead of a
// hardcoded host path — keeps the script portable across machines and
// satisfies Rule 1. Operators target the deployed payload by passing
// --argos-root explicitly (see Usage above).
const ARGOS_ROOT = flag("--argos-root", process.env.ARGOS_ROOT || process.cwd());
const MIN_BYTES = parseInt(flag("--min-bytes", "500000"), 10);

const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    const url = new URL(path, BASE);
    const body = opts.body ?? null;
    const headers = { ...(opts.headers || {}) };
    if (body && !headers["content-length"]) {
      headers["content-length"] = Buffer.byteLength(body);
    }
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
        agent,
        // 35 min — covers a worst-case full trilogy re-ingest with
        // headroom. Route caps itself at 30 min; this gives the
        // socket some slack on top.
        timeout: opts.timeoutMs || 35 * 60 * 1000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolveResult({
            ok: true,
            status: res.statusCode,
            text,
            json: () => {
              try {
                return JSON.parse(text);
              } catch {
                return null;
              }
            },
          });
        });
      }
    );
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

async function waitReady(maxSec = 45) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req("/api/voice/status");
    if (r.ok && r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

console.log(`reingest-large-docs`);
console.log(`  ARGOS_ROOT  = ${ARGOS_ROOT}`);
console.log(`  port        = ${PORT}`);
console.log(`  min-bytes   = ${MIN_BYTES}`);

let server = null;
try {
  console.log(`\n[boot] starting next start on port ${PORT}`);
  server = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules", "next", "dist", "bin", "next"),
      "start",
      "-p",
      String(PORT),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ARGOS_ROOT,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  if (!(await waitReady(45))) throw new Error("server failed to come up");
  console.log("[boot] ready");

  // List first so we can show the operator what's about to be touched.
  console.log("\n=== docs at or above threshold ===");
  const listRes = await req("/api/vault/list");
  if (!listRes.ok || listRes.status !== 200) {
    throw new Error(`/api/vault/list HTTP ${listRes.status}: ${listRes.text}`);
  }
  const listJson = listRes.json();
  const docs = (listJson?.documents ?? []).filter(
    (d) => d.byteSize >= MIN_BYTES
  );
  if (docs.length === 0) {
    console.log(`  (none — nothing to do)`);
    process.exit(0);
  }
  for (const d of docs) {
    const mb = (d.byteSize / 1_000_000).toFixed(2);
    console.log(
      `  · ${d.filename}  (${mb} MB, ${d.chunkCount} chunks before)`
    );
  }

  console.log("\n=== POST /api/vault/reingest ===");
  console.log(`  this may take a while — ~1s per chunk over Ollama embed`);
  const t0 = Date.now();
  const r = await req("/api/vault/reingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ minByteSize: MIN_BYTES }),
  });
  const totalMs = Date.now() - t0;
  if (!r.ok) {
    console.log(`[error] ${r.error}`);
    process.exit(1);
  }
  if (r.status !== 200) {
    console.log(`[error] HTTP ${r.status}: ${r.text.slice(0, 400)}`);
    process.exit(1);
  }
  const j = r.json();
  console.log(
    `\n  okCount=${j.okCount}  failCount=${j.failCount}  wallTime=${(totalMs / 1000).toFixed(1)}s`
  );
  for (const res of j.results ?? []) {
    if (res.ok) {
      const dur = res.durationMs / 1000;
      const delta = res.chunkCountAfter - res.chunkCountBefore;
      const sign = delta >= 0 ? "+" : "";
      console.log(
        `  [ok ] ${res.filename}`
      );
      console.log(
        `         chunks: ${res.chunkCountBefore} → ${res.chunkCountAfter}  (${sign}${delta})   re-embed: ${dur.toFixed(1)}s`
      );
    } else {
      console.log(`  [FAIL] ${res.filename}: ${res.error}`);
    }
  }
} catch (e) {
  console.log(`[fatal] ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
      }
    } catch {}
  }
  agent.destroy();
}
