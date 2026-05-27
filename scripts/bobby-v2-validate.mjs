#!/usr/bin/env node
// bobby-v2-validate.mjs — Bobby v2 (2026-05-27) directive validation.
//
// Boots ARGOS in a tmp ARGOS_ROOT and sends Bobby the 3 directive
// prompts in order, capturing TTFT, total wall, char count, and
// the response text. Also snapshots nvidia-smi during the first
// Bobby inference so we can see whether the 16b model spilled
// layers to system RAM.
//
// Bart→Bobby cold-swap latency: we warm Bart first (forces the 9b
// model resident), then send the first Bobby prompt and measure
// load_duration from the Ollama response (this is the model swap +
// load cost on Bobby's side).
//
// Single-purpose, throw-away harness. Not part of npm scripts.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

const PROMPTS = [
  {
    label: "P1 — CSV reader",
    text: "Write a Python script that reads a CSV file and prints the first 5 rows.",
  },
  {
    label: "P2 — FileNotFoundError debug",
    text: "The script above is throwing a FileNotFoundError. Debug it.",
  },
  {
    label: "P3 — confidence interval",
    text: "What is a confidence interval?",
  },
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

function nvidiaSmiSnapshot() {
  try {
    const r = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { encoding: "utf8" }
    );
    if (r.status !== 0) return `nvidia-smi failed: ${r.stderr || "exit " + r.status}`;
    const line = (r.stdout || "").trim().split("\n")[0] || "";
    const [usedMB, totalMB, util] = line.split(",").map((s) => s.trim());
    return `used=${usedMB}MB / total=${totalMB}MB · GPU util=${util}%`;
  } catch (e) {
    return `nvidia-smi unavailable: ${e.message}`;
  }
}

async function bobbyChat(text, takeSmiAfterTTFT = false, priorMessages = []) {
  const t0 = Date.now();
  let firstTokenAt = null;
  let content = "";
  let loadDuration = 0;
  let promptEvalDuration = 0;
  let evalCount = 0;
  let evalDuration = 0;
  let smiAtTTFT = null;
  let errored = null;

  await new Promise((resolveResult) => {
    const url = new URL("/api/chat", BASE);
    const body = JSON.stringify({
      messages: [...priorMessages, { role: "user", content: text }],
      personaId: "bobby",
      model: "second_constantine/deepseek-coder-v2:16b",
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
                if (j.error) {
                  errored = j.error;
                  continue;
                }
                if (j.message?.content) {
                  if (firstTokenAt === null) {
                    firstTokenAt = Date.now();
                    if (takeSmiAfterTTFT) smiAtTTFT = nvidiaSmiSnapshot();
                  }
                  content += j.message.content;
                }
                if (j.done) {
                  loadDuration = Math.round((j.load_duration ?? 0) / 1e6);
                  promptEvalDuration = Math.round((j.prompt_eval_duration ?? 0) / 1e6);
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
    r.on("error", (e) => { errored = e.message; resolveResult(); });
    r.write(body);
    r.end();
  });

  const total = Date.now() - t0;
  return {
    ttft: firstTokenAt ? firstTokenAt - t0 : null,
    total,
    chars: content.length,
    loadDuration,
    promptEvalDuration,
    evalCount,
    evalDuration,
    tokensPerSec: evalDuration > 0 ? (evalCount / (evalDuration / 1000)).toFixed(1) : "n/a",
    smiAtTTFT,
    errored,
    content,
  };
}

const root = mkdtempSync(join(tmpdir(), "argos-bobby-v2-"));
console.log(`bobby-v2-validate  ARGOS_ROOT=${root}  port=${PORT}`);
console.log(`nvidia-smi (pre-boot): ${nvidiaSmiSnapshot()}`);

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
  console.log("[boot] ready\n");

  console.log("=== Bart warmup (forces 9b resident) ===");
  const warmStart = Date.now();
  const warm = await req("/api/model/warm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b" }),
    timeoutMs: 120_000,
  });
  console.log(`  warm status=${warm.status} wallMs=${Date.now() - warmStart}`);
  console.log(`  nvidia-smi (Bart resident): ${nvidiaSmiSnapshot()}`);

  console.log("\n=== Bobby — 3-prompt validation ===");
  // P1 + P2 share a thread (P2 references "the script above"). P3 is
  // a separate fresh thread — it tests Bobby's restraint when no code
  // is needed, and we don't want P1+P2 priming to interfere.
  const thread = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    const p = PROMPTS[i];
    console.log(`\n--- ${p.label} ---`);
    // P3 is a clean thread; P1 and P2 share history.
    const prior = i === 2 ? [] : thread;
    const r = await bobbyChat(p.text, i === 0, prior);
    if (r.errored) {
      console.log(`  ERROR: ${r.errored}`);
      continue;
    }
    console.log(`  ttft=${r.ttft}ms  total=${r.total}ms  chars=${r.chars}  tps=${r.tokensPerSec}`);
    console.log(`  load=${r.loadDuration}ms  promptEval=${r.promptEvalDuration}ms  evalCount=${r.evalCount}`);
    if (r.smiAtTTFT) console.log(`  nvidia-smi @TTFT: ${r.smiAtTTFT}`);
    console.log(`  ---`);
    console.log(r.content);
    console.log(`  ---`);
    // Carry P1's exchange into P2's prompt so "the script above" has
    // a referent.
    if (i === 0) {
      thread.push({ role: "user", content: p.text });
      thread.push({ role: "assistant", content: r.content });
    }
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
