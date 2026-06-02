#!/usr/bin/env node
// verify-v233.mjs — live end-to-end evidence for the v2.3.2-pilot bug fixes.
//
//   BUG 1 — "Who is the CEO of Levi Strauss?" must route to chain_search_to_read,
//           read the pages, and have Bart answer "Michelle Gass" from real
//           content — NOT hallucinate "Michael Levy" from frozen training data.
//   BUG 2 — the visible answer must contain NO leaked tool-call JSON
//           (>{"id":"chain_search_to_read","params":…}).
//
// This boots `next start` against a throwaway ARGOS_ROOT, asks the exact
// operator question, and asserts on Bart's real streamed answer. Requires the
// model + live internet (DuckDuckGo + Jina Reader).
//
// Usage: node scripts/verify-v233.mjs [--port 7866]

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
const ROOT = join(tmpdir(), `argos-verify-v233-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function chat(base, messages, persona = "bartimaeus", model = MODEL) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages, personaId: persona, model, useRetrieval: false, truthMode: false }));
    const url = new URL("/api/chat", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { "content-type": "application/json", "content-length": body.length }, timeout: 180000 }, (resp) => {
      let buf = "", text = "";
      resp.on("data", (c) => {
        buf += c.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { const j = JSON.parse(line); if (j?.message?.content) text += j.message.content; } catch { /* */ }
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

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] verify-v233 (LIVE — model + internet)\n");

  console.log("=== BUG 1 — CEO of Levi Strauss grounded from live pages ===");
  const a = await chat(base, [{ role: "user", content: "Who is the CEO of Levi Strauss?" }]);
  console.log(`A: ${a}\n`);
  check("answer names Gass (from read pages)", /gass/i.test(a), "");
  check("did NOT hallucinate 'Michael Levy'", !/michael\s+lev/i.test(a), "");
  check("no 'speculation/unsupported' hedge", !/unsupported|speculation/i.test(a), "");

  console.log("\n=== BUG 2 — no leaked tool-call JSON in the visible answer ===");
  check("no '\"id\":' tool blob leaked", !/"id"\s*:/.test(a), "");
  check("no chain_search_to_read literal leaked", !/chain_search_to_read/.test(a), "");
  check("no stray '>{' control prefix", !/>\s*\{\s*"id"/.test(a), "");
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nverify-v233: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
