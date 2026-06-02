#!/usr/bin/env node
// validate-bart-memory.mjs — 2-turn conversational-memory gate for Bart
// (2026-06-02, post model swap to aratan/gemma-4-E4B-q8-it-heretic).
//
// Turn 1: establish project context (codename Asher).
// Turn 2: ask what was established.
// ASSERT turn 2 response contains "Asher". Pass/fail (exit code).
//
// Usage: node scripts/validate-bart-memory.mjs [--port 7866]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7866;
const ROOT = join(tmpdir(), `argos-bart-memory-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

function chat(base, messages) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages, personaId: "bartimaeus", model: MODEL, useRetrieval: false, truthMode: false }));
    const url = new URL("/api/chat", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { "content-type": "application/json", "content-length": body.length }, timeout: 150000 }, (resp) => {
      let buf = "", text = "";
      resp.on("data", (c) => {
        buf += c.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { const j = JSON.parse(line); if (j?.message?.content) text += j.message.content; } catch {}
        }
      });
      resp.on("end", () => res(text.trim()));
    });
    r.on("error", () => res("[error]")); r.on("timeout", () => { r.destroy(); res("[timeout]"); });
    r.write(body); r.end();
  });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000));
  } return false;
}

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log(`\n[boot] Bart memory gate (LIVE, ${MODEL})\n`);
  const first = await chat(base, [{ role: "user", content: "My project is codenamed Asher. Keep that in mind." }]);
  console.log(`  turn 1: ${first.slice(0, 120)}`);
  const second = await chat(base, [
    { role: "user", content: "My project is codenamed Asher. Keep that in mind." },
    { role: "assistant", content: first },
    { role: "user", content: "What did I just tell you my project is codenamed?" },
  ]);
  console.log(`  turn 2: ${second}\n`);
  check("turn 2 recalls the codename (contains 'Asher')", /\basher\b/i.test(second), second.slice(0, 80));
  check("turn 2 does NOT deny memory", !/\b(have not|haven't|don'?t (have|retain)|no memory|not (told|mentioned|specified))\b/i.test(second));
} catch (e) {
  console.error(`[fatal] ${e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
console.log(`\nvalidate-bart-memory: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
