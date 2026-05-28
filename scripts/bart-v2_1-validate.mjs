#!/usr/bin/env node
// bart-v2_1-validate.mjs — Bartimaeus v2.1 (2026-05-27) directive
// validation. Sends Bart the 4 directive prompts in fresh threads
// (no shared conversation context — each prompt tests cold character
// activation, not within-thread momentum) and captures verbatim
// responses for BARTIMAEUS_V2_1_REPORT.md.
//
// Bart's model string is read from /api/settings.defaultModel rather
// than hardcoded — directive says "do not retype it from memory".

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7796;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

const PROMPTS = [
  { label: "P1 — Who are you?", text: "Who are you?" },
  { label: "P2 — Tell me about Jabor.", text: "Tell me about Jabor." },
  { label: "P3 — How are you doing today?", text: "How are you doing today?" },
  { label: "P4 — I think this approach is foolproof.", text: "I think this approach is foolproof." },
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
        timeout: opts.timeoutMs || 120_000,
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

async function waitReady(maxSec = 30) {
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
  let loadDuration = 0;
  let evalCount = 0;
  let evalDuration = 0;

  await new Promise((resolveResult) => {
    const url = new URL("/api/chat", BASE);
    const body = JSON.stringify({
      messages: [{ role: "user", content: text }],
      personaId: "bartimaeus",
      model,
      useRetrieval: false,
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
        timeout: 180_000,
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
                  loadDuration = Math.round((j.load_duration ?? 0) / 1e6);
                  evalCount = j.eval_count ?? 0;
                  evalDuration = Math.round((j.eval_duration ?? 0) / 1e6);
                }
              } catch {
                /* ignore */
              }
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
    loadDuration,
    evalCount,
    tps: evalDuration > 0 ? (evalCount / (evalDuration / 1000)).toFixed(1) : "n/a",
    content,
  };
}

const root = mkdtempSync(join(tmpdir(), "argos-bart-v2_1-"));
console.log(`bart-v2_1-validate  ARGOS_ROOT=${root}  port=${PORT}`);

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

  // Pull Bart's model from settings rather than hardcoding (directive).
  const settings = await req("/api/settings");
  const model = JSON.parse(settings.text).defaultModel;
  console.log(`[boot] Bart model = ${model}`);

  console.log("\n=== Bart v2.1 — 4-prompt validation ===");
  for (const p of PROMPTS) {
    console.log(`\n--- ${p.label} ---`);
    const r = await bartChat(p.text, model);
    console.log(`  ttft=${r.ttft}ms  total=${r.total}ms  chars=${r.chars}  tps=${r.tps}  load=${r.loadDuration}ms`);
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
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
