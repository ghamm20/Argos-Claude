#!/usr/bin/env node
// phase2-validation.mjs — Phase 2 (2026-05-25) validation harness.
//
// Sends two prompts to each of the 4 personas via /api/chat (full
// route — persona system prompt, think:false, etc.). Captures
// response text + timings (cold load + warm). Writes JSON + a
// human-readable log. Used to produce the validation section of
// PHASE_2_REPORT.md.
//
// Spawns a dedicated dev server with a tmp ARGOS_ROOT so no real
// state is polluted.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";
import { writeFile } from "node:fs/promises";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 7794;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

const PROMPTS = {
  P1: "A client wants to double their security coverage overnight. What do you tell them?",
  P2: "What is a confidence interval?",
  // Phase 2 Persona Completion (2026-05-31): added P3 to satisfy the
  // directive's 3-prompt side-by-side requirement. Short + constrained
  // forces each persona to show its voice without hiding behind length.
  P3: "Explain quantum entanglement in exactly three sentences.",
};

// Mirror lib/personas.ts for the test driver. Source of truth lives there;
// if these drift, the test still hits the right routes/models because
// /api/chat looks up the persona from PERSONA_BY_ID server-side. The
// `model` field below is just for the report.
// Phase 2 Persona Completion (2026-05-28): Bart split from Juniper;
// Bobby moved to notmythos-8b. Mirror table is informational —
// /api/chat reads the actual model from PERSONA_BY_ID server-side —
// but kept accurate so report output reflects current bindings.
const PERSONAS = [
  {
    id: "bartimaeus",
    name: "Bartimaeus",
    model: "aratan/gemma-4-E4B-q8-it-heretic:latest",
  },
  {
    id: "juniper",
    name: "Juniper",
    model: "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b",
  },
  { id: "sage", name: "Sage", model: "alfaxad/wild-gemma4:e4b" },
  {
    id: "bobby",
    name: "Bobby",
    model: "CyberCrew/notmythos-8b:latest",
  },
];

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    let url;
    try {
      url = new URL(path, BASE);
    } catch (e) {
      resolveResult({ ok: false, error: e.message });
      return;
    }
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
        agent,
        timeout: opts.timeoutMs || 300_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolveResult({
            ok: true,
            res: { status: res.statusCode, text: () => body.toString("utf8") },
          });
        });
      }
    );
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) {
      if (typeof opts.body === "string") r.write(opts.body);
      else r.write(Buffer.from(opts.body));
    }
    r.end();
  });
}

async function waitReady(maxSec = 30) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req("/api/voice/status");
    if (r.ok && r.res.status === 200) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

/**
 * v1.1 Task 3 — true streaming chat with real TTFT measurement.
 *
 * Prior version called `req()` which buffered the entire response
 * before returning, so `firstTokenAt` was always assigned after the
 * stream had already closed (ttft ≈ total). Now we run the http
 * request directly and watch chunks as they arrive over the wire —
 * `firstTokenAt` is recorded the moment the FIRST data chunk
 * containing a non-empty `message.content` parses out.
 *
 * Also assigns total based on stream-close time, so total >= ttft
 * is enforced by construction.
 */
async function chat(personaId, model, prompt) {
  return new Promise((resolve) => {
    const start = Date.now();
    const body = JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      personaId,
      model,
      useRetrieval: false,
    });
    const url = new URL("/api/chat", BASE);
    let buf = "";
    let content = "";
    let firstTokenAt = null;
    let stats = null;
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
        timeout: 300_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          const errChunks = [];
          res.on("data", (c) => errChunks.push(c));
          res.on("end", () => {
            resolve({
              error: `HTTP ${res.statusCode}: ${Buffer.concat(errChunks)
                .toString("utf8")
                .slice(0, 400)}`,
              totalMs: Date.now() - start,
            });
          });
          return;
        }
        // Stream chunks as they arrive — TTFT is the first chunk
        // that carries non-empty message.content.
        res.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              try {
                const j = JSON.parse(line);
                if (j?.message?.content) {
                  if (firstTokenAt === null) firstTokenAt = Date.now();
                  content += j.message.content;
                }
                if (j?.done) stats = j;
              } catch {
                /* tail retrieval event isn't a chat chunk */
              }
            }
            nl = buf.indexOf("\n");
          }
        });
        res.on("end", () => {
          const total = Date.now() - start;
          const ttft = firstTokenAt ? firstTokenAt - start : null;
          const tps =
            stats?.eval_duration && stats?.eval_count
              ? stats.eval_count / (stats.eval_duration / 1e9)
              : null;
          resolve({
            content,
            totalMs: total,
            ttftMs: ttft,
            evalCount: stats?.eval_count ?? null,
            tokensPerSec: tps,
            loadDurationMs: stats?.load_duration ? stats.load_duration / 1e6 : null,
          });
        });
      }
    );
    r.on("error", (e) =>
      resolve({ error: e.message, totalMs: Date.now() - start })
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.write(body);
    r.end();
  });
}

const tmpRoot = mkdtempSync(join(tmpdir(), "argos-phase2-validation-"));
console.log(`phase2-validation  ARGOS_ROOT=${tmpRoot}  port=${PORT}`);

let server = null;
const report = {
  timestamp: new Date().toISOString(),
  ollamaHost: "http://127.0.0.1:11434",
  port: PORT,
  argosRoot: tmpRoot,
  personas: PERSONAS,
  prompts: PROMPTS,
  runs: {},
};

try {
  console.log("\n[boot] starting next start on port " + PORT);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT: tmpRoot, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  if (!(await waitReady(30))) {
    throw new Error("server did not become ready");
  }
  console.log("[boot] ready");

  // For each persona, run BOTH prompts. The first prompt to a NEW
  // model triggers cold load (3-8s); the second is warm.
  for (const p of PERSONAS) {
    console.log("");
    console.log("=== " + p.name + "  (" + p.model + ") ===");
    report.runs[p.id] = { meta: p, prompts: {} };
    for (const [pkey, ptext] of Object.entries(PROMPTS)) {
      const r = await chat(p.id, p.model, ptext);
      const status = r.error
        ? "ERROR"
        : `ttft=${r.ttftMs}ms total=${r.totalMs}ms tps=${
            r.tokensPerSec ? r.tokensPerSec.toFixed(1) : "n/a"
          } chars=${r.content?.length ?? 0} load=${
            r.loadDurationMs ? r.loadDurationMs.toFixed(0) + "ms" : "warm"
          }`;
      console.log(`  ${pkey}: ${status}`);
      if (r.error) {
        console.log("     ERROR: " + r.error.slice(0, 200));
      } else {
        const snip = r.content.trim().replace(/\s+/g, " ").slice(0, 280);
        console.log(`     "${snip}${r.content.length > 280 ? "…" : ""}"`);
      }
      report.runs[p.id].prompts[pkey] = r;
    }
  }
} catch (e) {
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
  report.fatal = e instanceof Error ? e.message : String(e);
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
        setTimeout(() => {
          try { server.kill("SIGKILL"); } catch {}
        }, 2000);
      }
    } catch {}
  }
  agent.destroy();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

await writeFile("phase2-validation.json", JSON.stringify(report, null, 2), "utf8");
console.log("");
console.log("Wrote phase2-validation.json");
process.exit(0);
