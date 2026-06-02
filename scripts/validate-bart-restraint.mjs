#!/usr/bin/env node
// validate-bart-restraint.mjs — live check that Bart's restraint update lands.
// Boots next start (temp ARGOS_ROOT, no vault/memory noise), sends a few
// prompts to Bartimaeus, and prints the responses + word counts so the
// operator can see brevity is real. Evidence collector, not a pass/fail gate.

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7863;
const ROOT = join(tmpdir(), `argos-bart-restraint-${process.pid}`);
const MODEL = "royhodge812/Orchestrator:lates";

function ask(base, prompt) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      personaId: "bartimaeus", model: MODEL, useRetrieval: false, truthMode: false,
    }));
    const url = new URL("/api/chat", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { "content-type": "application/json", "content-length": body.length }, timeout: 120000 }, (resp) => {
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
    r.on("error", () => res("[request error]"));
    r.on("timeout", () => { r.destroy(); res("[timeout]"); });
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
const prompts = [
  "What's the capital of France?",
  "Is correlation the same as causation?",
  "Give me three reasons a USB-native AI is more private than a cloud one.",
];
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] Bartimaeus restraint validation (LIVE)\n");
  for (const p of prompts) {
    const a = await ask(base, p);
    const words = a.split(/\s+/).filter(Boolean).length;
    console.log(`Q: ${p}`);
    console.log(`A (${words} words): ${a}\n`);
  }
} catch (e) {
  console.error(`[fatal] ${e.message}`);
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
