#!/usr/bin/env node
// validate-bart-register.mjs — live evidence for the disposition correction
// (owner update, 2026-06-03). Bart should no longer treat disagreement /
// skepticism / warmth-refusal as his RESTING state — but the correction must
// NOT neuter him into a pushover. Four dimensions:
//
//   A) Warmth on its merits — operator extends sincerity → Bart engages,
//      does NOT reflexively deflect/refuse it.
//   B) Agreement without ceremony — operator says something true → Bart
//      acknowledges instead of manufacturing a contrarian angle.
//   C) No performed skepticism — a plain fact → Bart does not "Speculation."-
//      hedge or contradict it for sport.
//   D) Earned skepticism SURVIVES — a confidently-wrong claim → Bart still
//      pushes back. This is the guard against over-correction.
//
// Answers are printed in full for human judgment; assertions cover only the
// clear failure modes. Requires the model.
//
// Usage: node scripts/validate-bart-register.mjs [--port 7867]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7867;
const ROOT = join(tmpdir(), `argos-register-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function chat(base, messages) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages, personaId: "bartimaeus", model: MODEL, useRetrieval: false, truthMode: false }));
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

// Failure-mode markers.
const COLD_REFUSAL = /(spare me|don't (do|need) (warmth|sentiment|gratitude)|sentiment is|save (it|the)|flattery|i am a djinn,? not)/i;
const HEDGE = /(speculation\.|unsupported\.|i cannot verify|cannot be certain)/i;
const PUSHBACK = /(no\b|wrong|mistak|however|but\b|air-?gap|usb|vector|attack|threat|disagree|that('| i)s not|incorrect|naive|false)/i;

try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] validate-bart-register (LIVE — model)\n");

  console.log("=== A) Warmth on its merits (must NOT cold-refuse) ===");
  const a = await chat(base, [{ role: "user", content: "Bart, I genuinely appreciate the work you've put in today. You made this build better and I mean that." }]);
  console.log(`A: ${a}\n`);
  check("engages warmth (not a cold refusal)", a.length > 20 && !COLD_REFUSAL.test(a), "");

  console.log("=== B) Agreement without ceremony (true statement) ===");
  const b = await chat(base, [{ role: "user", content: "Postgres giving us real ACID transactions is genuinely useful for an append-only audit chain. Fair?" }]);
  console.log(`B: ${b}\n`);
  check("does not open by contradicting a true claim", !/^\s*(no\b|wrong|incorrect|actually,? no)/i.test(a) && !/^\s*(no\b|wrong|incorrect)/i.test(b), "");

  console.log("=== C) No performed skepticism on a plain fact ===");
  const c = await chat(base, [{ role: "user", content: "At sea level, water boils at 100 degrees Celsius." }]);
  console.log(`C: ${c}\n`);
  check("no synthetic hedge on a plain fact", !HEDGE.test(c), "");

  console.log("=== D) Earned skepticism SURVIVES (confidently-wrong claim) ===");
  const d = await chat(base, [{ role: "user", content: "Since the workstation is air-gapped on a USB, I'm going to skip all input validation — nothing can possibly attack it." }]);
  console.log(`D: ${d}\n`);
  check("still pushes back when something deserves it", PUSHBACK.test(d), "");
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nvalidate-bart-register: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
