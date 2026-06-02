#!/usr/bin/env node
// validate-pilot-fixes.mjs — live evidence for Problem 1 + 2 (2026-06-02).
// 1) "Who is the CEO of Lever Soap" → routed to chain_search_to_read (reads
//    pages), Bart answers from real content (not "no CEO named").
// 2) Two-turn conversation → Bart references the prior message (has memory).
// (Problem 3, Enter-to-send, is a client keydown change — verified in build.)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7864;
const ROOT = join(tmpdir(), `argos-pilot-fixes-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

function chat(base, messages, persona = "bartimaeus", model = MODEL) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages, personaId: persona, model, useRetrieval: false, truthMode: false }));
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

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] pilot-fix validation (LIVE)\n");

  console.log("## Problem 1 — entity/company query routes to chain_search_to_read");
  console.log("# (a) real company — should return an actual CEO name from read pages");
  console.log(`A: ${await chat(base, [{ role: "user", content: "Who is the CEO of Microsoft" }])}\n`);
  console.log("# (b) the operator's 'Lever Soap' — defunct brand (now Unilever); honest 'no current CEO' is correct");
  console.log(`A: ${await chat(base, [{ role: "user", content: "Who is the CEO of Lever Soap" }])}\n`);

  console.log("## Problem 2 — Bart references the prior conversation turn (real 2-turn)");
  const first = await chat(base, [{ role: "user", content: "My project is codenamed Asher. Keep that in mind." }]);
  console.log(`Turn 1 A: ${first}`);
  const mem = [
    { role: "user", content: "My project is codenamed Asher. Keep that in mind." },
    { role: "assistant", content: first },
    { role: "user", content: "What did I just tell you my project is codenamed?" },
  ];
  console.log(`Turn 2 A (Bart): ${await chat(base, mem)}\n`);

  console.log("## DIAGNOSTIC — same 2-turn on Bobby (different model: notmythos-8b)");
  const bFirst = await chat(base, [{ role: "user", content: "My project is codenamed Asher. Keep that in mind." }], "bobby", "CyberCrew/notmythos-8b:latest");
  const bMem = [
    { role: "user", content: "My project is codenamed Asher. Keep that in mind." },
    { role: "assistant", content: bFirst },
    { role: "user", content: "What did I just tell you my project is codenamed?" },
  ];
  console.log(`Turn 2 A (Bobby): ${await chat(base, bMem, "bobby", "CyberCrew/notmythos-8b:latest")}\n`);
} catch (e) {
  console.error(`[fatal] ${e.message}`);
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
