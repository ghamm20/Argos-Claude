#!/usr/bin/env node
// smoke-voice-f5.mjs — Phase 7-C F5-TTS Bartimaeus voice-clone gate.
//
// Verifies the persona-branching TTS path:
//   1. /api/voice/status reports F5 availability (cli + reference clip)
//   2. Bartimaeus TTS  → F5-TTS path taken (x-voice-engine: f5-tts), real
//      non-empty WAV produced, latency logged
//   3. Other persona   → does NOT take the F5 path (stays on Piper)
//   4. F5 unavailable  → Bartimaeus falls back to Piper, no crash (graceful)
//
// NOTE (honest): Piper is operator-supplied and may be absent on the test
// box. When it is, the "other persona" + "fallback" paths legitimately return
// a 5xx "no Piper engine" — the smoke asserts the ROUTING (not-F5) and that
// the server stays alive (graceful), not that Piper produced audio.
//
// Usage: node scripts/smoke-voice-f5.mjs [--port 7811]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7811;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function req(base, path, opts = {}) {
  return new Promise((res) => {
    let url;
    try { url = new URL(path, base); } catch (e) { res({ ok: false, error: e.message }); return; }
    const r = http.request(
      { method: opts.method || "GET", hostname: url.hostname, port: url.port,
        path: url.pathname + url.search, headers: opts.headers || {}, timeout: opts.timeoutMs || 30_000 },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8")); } catch { /* binary */ }
          res({ ok: true, status: resp.statusCode, headers: resp.headers, buf, json });
        });
      }
    );
    r.on("error", (e) => res({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function ttsBody(personaId, text) {
  return JSON.stringify({ personaId, text });
}

async function waitReady(base, maxSec = 45) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req(base, "/api/voice/status");
    if (r.ok && r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(label, env, port, fn) {
  console.log(`\n[boot] ${label} — next start :${port}`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready");
    await fn(base);
  } finally {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      else server.kill("SIGKILL");
    } catch { /* best effort */ }
  }
}

const SHORT = "Ah. Another mortal requiring my expertise.";

try {
  // ===== Scenario A: F5 available (default ARGOS_F5_HOME) =====
  await withServer("F5 available", { ARGOS_ROOT: repoRoot }, BASE_PORT, async (base) => {
    console.log("\n=== 1. /api/voice/status — F5 availability ===");
    const s = await req(base, "/api/voice/status");
    check("status 200", s.ok && s.status === 200);
    const f5 = s.json?.f5 ?? {};
    check("f5.available true", f5.available === true, `(reason=${f5.reason ?? "none"})`);
    check("f5.referenceWav present", typeof f5.referenceWav === "string" && f5.referenceWav.length > 0);
    check("f5.cli present", typeof f5.cli === "string" && f5.cli.length > 0);

    console.log("\n=== 2. Bartimaeus TTS → F5-TTS path ===");
    const t0 = Date.now();
    const r = await req(base, "/api/voice/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: ttsBody("bartimaeus", SHORT), timeoutMs: 180_000,
    });
    const ms = Date.now() - t0;
    check("bart tts 200", r.ok && r.status === 200, `(${r.status})`);
    check("engine header is f5-tts", r.headers?.["x-voice-engine"] === "f5-tts", `(${r.headers?.["x-voice-engine"]})`);
    check("content-type audio/wav", String(r.headers?.["content-type"]).startsWith("audio/wav"));
    const isWav = r.buf && r.buf.length > 1000 && r.buf.slice(0, 4).toString("ascii") === "RIFF";
    check("output is non-empty RIFF WAV", isWav, `(${r.buf?.length ?? 0} bytes)`);
    console.log(`  [latency] Bartimaeus F5-TTS: ${ms} ms for "${SHORT}" (${r.buf?.length ?? 0} bytes)`);

    console.log("\n=== 3. Other persona (Bobby) → NOT the F5 path ===");
    const rb = await req(base, "/api/voice/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: ttsBody("bobby", "Disk at ninety percent."), timeoutMs: 60_000,
    });
    check("bobby did NOT use F5 engine", rb.headers?.["x-voice-engine"] !== "f5-tts", `(engine=${rb.headers?.["x-voice-engine"] ?? "none"}, status=${rb.status})`);
    check("server stayed alive (graceful, no crash)", rb.ok && typeof rb.status === "number");
    if (rb.status !== 200) {
      console.log(`  [note] Bobby returned ${rb.status} — Piper not installed on this box (operator-supplied). Routing correctly avoided F5.`);
    }
  });

  // ===== Scenario B: F5 unavailable → graceful Piper fallback =====
  // ARGOS_F5_DISABLE genuinely turns F5 off (a bogus ARGOS_F5_HOME no longer
  // works now that detection auto-probes ~/dev/f5-tts + the ARGOS_ROOT sibling).
  await withServer("F5 unavailable", { ARGOS_ROOT: repoRoot, ARGOS_F5_DISABLE: "1" }, BASE_PORT + 1, async (base) => {
    console.log("\n=== 4. F5 unavailable → Bartimaeus falls back to Piper, no crash ===");
    const s = await req(base, "/api/voice/status");
    check("status 200 (F5-down server)", s.ok && s.status === 200);
    check("f5.available false when home is bogus", s.json?.f5?.available === false, `(${s.json?.f5?.available})`);
    const r = await req(base, "/api/voice/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: ttsBody("bartimaeus", SHORT), timeoutMs: 60_000,
    });
    check("bart did NOT use F5 (fell back)", r.headers?.["x-voice-engine"] !== "f5-tts", `(engine=${r.headers?.["x-voice-engine"] ?? "none"}, status=${r.status})`);
    check("graceful — server responded, no crash/hang", r.ok && typeof r.status === "number", `(status=${r.status})`);
  });
} catch (e) {
  fail++;
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
}

console.log("");
console.log(`smoke-voice-f5: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
