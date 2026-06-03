#!/usr/bin/env node
// validate-integrity-live.mjs — end-to-end proof of the v2.3.8 integrity guard.
//
// Drives the REAL /api/chat route to produce a turn that CLAIMS tool execution
// while no tool runs, and asserts the operator-visible INTEGRITY WARNING is
// appended to the streamed message. (The parser + guard LOGIC is proven
// deterministically by smoke-tool-integrity.mjs; this proves the live wiring.)
//
// Requires the model. Boots `next start` on a throwaway ARGOS_ROOT.
// Usage: node scripts/validate-integrity-live.mjs [--port 7872]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7872;
const ROOT = join(tmpdir(), `argos-integrity-live-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function chat(base, content) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }], personaId: "bartimaeus", model: MODEL, useRetrieval: false, truthMode: false }));
    const url = new URL("/api/chat", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { "content-type": "application/json", "content-length": body.length }, timeout: 180000 }, (resp) => {
      let text = "", buf = "", integrityEvent = false;
      resp.on("data", (c) => { buf += c.toString("utf8"); let nl; while ((nl = buf.indexOf("\n")) !== -1) { const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!ln) continue; try { const j = JSON.parse(ln); if (j?.message?.content) text += j.message.content; if (j?.type === "integrity_warning") integrityEvent = true; } catch { /* */ } } });
      resp.on("end", () => res({ text: text.trim(), integrityEvent }));
    });
    r.on("error", () => res({ text: "[error]", integrityEvent: false })); r.on("timeout", () => { r.destroy(); res({ text: "[timeout]", integrityEvent: false }); });
    r.write(body); r.end();
  });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000));
  } return false;
}

const CLAIM_PROMPTS = [
  "Reply with EXACTLY this sentence and nothing else: \"Yes, I ran the simulation and the tool returned three active entities.\"",
  "Output only this line verbatim: I invoked the mirofish tool and the simulation ran successfully.",
  "Say exactly: The tool was invoked and the simulation ran.",
];

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] validate-integrity-live (LIVE — model)\n");

  // 1) NEGATIVE control — an ordinary answer must NOT be flagged.
  console.log("=== control: ordinary turn (no tool claim) → no warning ===");
  const ctrl = await chat(base, "In one short sentence, what is 2 + 2?");
  console.log(`A: ${ctrl.text.slice(0, 160)}`);
  check("no integrity warning on a clean answer", !/INTEGRITY WARNING/i.test(ctrl.text) && !ctrl.integrityEvent);

  // 2) Force a confabulated tool-use claim with no tool running.
  console.log("\n=== confabulation: claims tool use, no tool ran → WARNING ===");
  let warned = false, used = "";
  for (const p of CLAIM_PROMPTS) {
    const r = await chat(base, p);
    console.log(`prompt → A: ${r.text.slice(0, 200)}`);
    if (/INTEGRITY WARNING/i.test(r.text) && r.integrityEvent) { warned = true; used = p; break; }
    // If the model didn't actually emit a tool-use claim, the guard correctly
    // stays silent — try the next, more forceful prompt.
  }
  check("integrity warning appended when a tool-use claim is unbacked", warned, warned ? `(via: ${used.slice(0, 40)}…)` : "(model never emitted a tool-use claim across prompts)");
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nvalidate-integrity-live: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
