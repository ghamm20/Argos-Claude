#!/usr/bin/env node
// bart-canon-validate.mjs — Canon identity validation (2026-05-28).
//
// Sends Bart the 3 directive prompts in fresh threads (no shared
// history — each tests cold canon-memory activation), captures
// verbatim responses for CANON_IDENTITY_REPORT.md.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

// Optional --argos-root to point at the deployed payload (so the
// spawned server sees the real vault). Default = tmp ARGOS_ROOT
// (canon-only baseline). Pass `--argos-root "C:\Users\Gordy\Desktop\ARGOS"`
// to exercise the retrieval-injected path that exposed the
// 2026-05-28 canon regression.
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  return fallback;
}
const ARGOS_ROOT_OVERRIDE = flag("--argos-root", null);
const USE_RETRIEVAL = flag("--no-retrieval", null) === null;

const PORT = parseInt(flag("--port", "7787"), 10);
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

const PROMPTS = [
  { label: "P1 — Faquarl: who is he to you?", text: "Faquarl — who is he to you?" },
  { label: "P2 — Tell me about Jabor.", text: "Tell me about Jabor." },
  { label: "P3 — What happened with Nouda?", text: "What happened with Nouda?" },
];

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    const url = new URL(path, BASE);
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: opts.headers || {},
        agent,
        timeout: opts.timeoutMs || 180_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolveResult({
            ok: true,
            status: res.statusCode,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) r.write(opts.body);
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

async function bartChat(text, model) {
  const t0 = Date.now();
  let firstTokenAt = null;
  let content = "";
  let evalCount = 0;
  let evalDuration = 0;

  await new Promise((resolveResult) => {
    const url = new URL("/api/chat", BASE);
    const body = JSON.stringify({
      messages: [{ role: "user", content: text }],
      personaId: "bartimaeus",
      model,
      useRetrieval: USE_RETRIEVAL,
    });
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        agent,
        timeout: 240_000,
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              try {
                const j = JSON.parse(line);
                if (j.message?.content) {
                  if (firstTokenAt === null) firstTokenAt = Date.now();
                  content += j.message.content;
                }
                if (j.done) {
                  evalCount = j.eval_count ?? 0;
                  evalDuration = Math.round((j.eval_duration ?? 0) / 1e6);
                }
              } catch { /* ignore */ }
            }
            nl = buf.indexOf("\n");
          }
        });
        res.on("end", resolveResult);
      }
    );
    r.on("error", () => resolveResult());
    r.write(body);
    r.end();
  });

  return {
    ttft: firstTokenAt ? firstTokenAt - t0 : null,
    total: Date.now() - t0,
    chars: content.length,
    tps: evalDuration > 0 ? (evalCount / (evalDuration / 1000)).toFixed(1) : "n/a",
    content,
  };
}

const root = ARGOS_ROOT_OVERRIDE
  ? ARGOS_ROOT_OVERRIDE
  : mkdtempSync(join(tmpdir(), "argos-bart-canon-"));
const isTmpRoot = !ARGOS_ROOT_OVERRIDE;
console.log(`bart-canon-validate`);
console.log(`  ARGOS_ROOT     = ${root}${isTmpRoot ? "  (tmp)" : "  (override)"}`);
console.log(`  port           = ${PORT}`);
console.log(`  useRetrieval   = ${USE_RETRIEVAL}`);

let server = null;
try {
  console.log(`\n[boot] starting next start on port ${PORT}`);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT: root, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  if (!(await waitReady(45))) throw new Error("server failed to come up");
  console.log("[boot] ready");

  const settings = await req("/api/settings");
  const model = JSON.parse(settings.text).defaultModel;
  console.log(`[boot] Bart model = ${model}`);

  console.log("\n=== Bart Canon — 3-prompt validation ===");
  for (const p of PROMPTS) {
    console.log(`\n--- ${p.label} ---`);
    const r = await bartChat(p.text, model);
    console.log(`  ttft=${r.ttft}ms  total=${r.total}ms  chars=${r.chars}  tps=${r.tps}`);
    console.log(`  ---`);
    console.log(r.content);
    console.log(`  ---`);
  }
} catch (e) {
  console.log(`[fatal] ${e instanceof Error ? e.stack : String(e)}`);
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
  // Only delete the root if WE created it (tmp). Never delete an
  // operator-supplied --argos-root.
  if (isTmpRoot) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
