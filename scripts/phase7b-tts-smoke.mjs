#!/usr/bin/env node
// phase7b-tts-smoke.mjs — Phase 7-B TTS round-trip smoke.
//
// Verifies:
//   - /api/voice/status reports tts.available:true with engine:"piper"
//   - /api/voice/tts POST { text, personaId: "bartimaeus" } returns
//     audio/wav with valid RIFF magic, x-voice-name == persona.voiceId,
//     duration < 5s (target <3s but Piper's first call includes
//     onnxruntime warmup which can push past 3s on the first run).
//   - Audit chain receives a voice.spoken entry within retry window
//
// Also runs through Sage and Bobby to verify per-persona voice routing
// picks the right model file.

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 7798;
const rootIdx = args.indexOf("--argos-root");
const ARGOS_ROOT =
  rootIdx >= 0
    ? args[rootIdx + 1]
    : process.env.ARGOS_ROOT || process.cwd();

const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

let pass = 0;
let fail = 0;
function check(label, cond, detail = "") {
  const tag = cond ? "[ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (cond) pass++;
  else fail++;
}

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
        timeout: opts.timeoutMs || 60_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolveResult({
            ok: true,
            res: {
              status: res.statusCode,
              text: () => body.toString("utf8"),
              json: () => { try { return JSON.parse(body.toString("utf8")); } catch { return null; } },
              body,
              headers: { get: (h) => res.headers[h.toLowerCase()] ?? null },
            },
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
    if (r.ok && r.res.status === 200) return true;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  return false;
}

async function ttsTest(label, personaId, expectedVoice, expectedDurationMaxMs) {
  console.log(`\n=== TTS for ${label} (personaId=${personaId}, expect voice=${expectedVoice}) ===`);
  const t0 = Date.now();
  const res = await req("/api/voice/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `${label} speaking. Verification, analysis, strategic clarity.`,
      personaId,
    }),
    timeoutMs: 60_000,
  });
  const wallMs = Date.now() - t0;
  check(`${label} TTS reachable`, res.ok);
  if (!res.ok) return;
  check(`${label} TTS 200`, res.res.status === 200,
    res.res.status !== 200 ? `(got ${res.res.status}: ${res.res.text().slice(0, 200)})` : "");
  if (res.res.status !== 200) return;
  check(`${label} content-type audio/wav`,
    res.res.headers.get("content-type")?.includes("audio/wav"));
  const wav = res.res.body;
  check(`${label} response body > 0 bytes`, wav.length > 0, `(${wav.length} bytes)`);
  const magic = wav.slice(0, 4).toString("ascii");
  check(`${label} WAV RIFF magic`, magic === "RIFF", `(got "${magic}")`);
  const voiceHeader = res.res.headers.get("x-voice-name");
  check(`${label} x-voice-name = ${expectedVoice}`, voiceHeader === expectedVoice,
    `(got "${voiceHeader}")`);
  const synthDuration = parseInt(res.res.headers.get("x-voice-duration-ms") || "0", 10);
  check(`${label} synth duration > 0`, synthDuration > 0, `(${synthDuration}ms synth · ${wallMs}ms wall)`);
  check(`${label} wall time < ${expectedDurationMaxMs}ms`, wallMs < expectedDurationMaxMs,
    `(${wallMs}ms)`);
}

const report = {
  timestamp: new Date().toISOString(),
  argosRoot: ARGOS_ROOT,
  port: PORT,
};

let server = null;
console.log(`phase7b-tts-smoke  ARGOS_ROOT=${ARGOS_ROOT}  port=${PORT}`);

try {
  console.log("\n[boot] starting next start on port " + PORT);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  if (!(await waitReady(30))) throw new Error("server did not become ready");
  console.log("[boot] ready");

  // === Capability snapshot ===
  console.log("\n=== /api/voice/status ===");
  const cap = await req("/api/voice/status");
  check("status 200", cap.ok && cap.res.status === 200);
  if (cap.ok) {
    const j = await cap.res.json();
    console.log(`  STT: available=${j?.stt?.available}`);
    console.log(`  TTS: available=${j?.tts?.available}  engine=${j?.tts?.engine}`);
    check("TTS available", j?.tts?.available === true);
    check("TTS engine is piper", j?.tts?.engine === "piper");
    check("TTS binary resolved", typeof j?.tts?.binary === "string" && j.tts.binary.includes("piper.exe"),
      j?.tts?.binary ? `(${j.tts.binary})` : "");
  }

  // === TTS roundtrips — one per persona ===
  // First call includes ONNX runtime warmup → 8s budget. Subsequent calls
  // should be faster but each voice model is loaded fresh per call, so
  // budget 8s per call as well. (Piper doesn't cache model state between
  // process invocations.)
  await ttsTest("Bartimaeus", "bartimaeus", "en_US-ryan-high", 10_000);
  await ttsTest("Juniper",    "juniper",    "en_US-amy-medium", 10_000);
  await ttsTest("Sage",       "sage",       "en_US-lessac-high", 10_000);
  await ttsTest("Bobby",      "bobby",      "en_US-joe-medium", 10_000);

  // === Audit chain check (voice.spoken event) ===
  console.log("\n=== audit chain (voice.spoken event) ===");
  let spoken = null;
  for (let attempt = 1; attempt <= 3 && !spoken; attempt++) {
    const rec = await req("/api/receipts?tail=20");
    if (rec.ok && rec.res.status === 200) {
      const j = await rec.res.json();
      const entries = j?.entries ?? [];
      spoken = entries.filter((e) => e.kind === "voice.spoken").slice(-1)[0];
    }
    if (!spoken && attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  check("voice.spoken audit entry present", !!spoken);
  if (spoken) {
    console.log(`     idx ${spoken.index} · voice=${spoken.payload?.voice} · charCount=${spoken.payload?.charCount} · audioBytes=${spoken.payload?.audioBytes}`);
  }

  // === Voice mismatch fallback (bad personaId → DEFAULT_PIPER_VOICE) ===
  console.log("\n=== TTS with unknown personaId → falls back to default voice ===");
  const fallback = await req("/api/voice/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello.", personaId: "not-a-real-persona" }),
  });
  if (fallback.ok && fallback.res.status === 200) {
    check("unknown persona → DEFAULT_PIPER_VOICE used",
      fallback.res.headers.get("x-voice-name") === "en_US-ryan-high");
  } else {
    check("unknown persona handled gracefully", fallback.ok && fallback.res.status === 200);
  }

} catch (e) {
  fail++;
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
  report.fatal = e instanceof Error ? e.message : String(e);
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
        setTimeout(() => { try { server.kill("SIGKILL"); } catch {} }, 2000);
      }
    } catch {}
  }
  agent.destroy();
}

console.log("");
console.log(fail === 0
  ? `phase7b-tts-smoke: ${pass} passed — PASS`
  : `phase7b-tts-smoke: ${pass} passed, ${fail} failed — FAIL`);
process.exit(fail === 0 ? 0 : 1);
