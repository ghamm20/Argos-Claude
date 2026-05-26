#!/usr/bin/env node
// phase7-stt-smoke.mjs — Phase 7 STT round-trip smoke.
//
// Generates a short 16kHz mono WAV (synthetic — either silence or a
// simple tone burst), POSTs to /api/voice/stt against a live server,
// confirms the route returns a coherent shape ({ text, durationMs,
// modelBasename, audioBytes }). Real-speech accuracy can't be
// validated without a human speaking into a mic — that's Task 7
// in PHASE_7_REPORT.md (operator manual step).
//
// What this DOES verify:
//   - Whisper binary is invokable from the server-side spawn pipeline
//   - The full lib/voice.ts → /api/voice/stt path produces a 200 with
//     the expected JSON shape (or 503 with hint if STT not installed)
//   - Audit chain gets a voice.transcribed entry
//   - Round-trip latency for a 1-2 second WAV
//
// Args: --port <N>  (default 7797 to match the manual test pattern)
//       --argos-root <path>  (default $ARGOS_ROOT or cwd)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 7797;
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
  return new Promise((resolve_) => {
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
          const body = Buffer.concat(chunks);
          resolve_({
            ok: true,
            res: {
              status: res.statusCode,
              text: () => body.toString("utf8"),
              json: () => {
                try { return JSON.parse(body.toString("utf8")); } catch { return null; }
              },
              headers: { get: (h) => res.headers[h.toLowerCase()] ?? null },
            },
          });
        });
      }
    );
    r.on("error", (e) => resolve_({ ok: false, error: e.message }));
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

// Build a 2-second 16kHz mono WAV containing a 440Hz tone burst.
// Whisper accepts WAV files of any speech-bearing content; a tone
// isn't speech so the transcription will be empty or near-empty —
// but the FULL PIPELINE (multipart upload → spawn whisper-cli → read
// out.txt → return JSON) is the actual gate.
function buildToneWav(seconds = 2, sampleRate = 16000, freqHz = 440) {
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freqHz * t) * 0.3; // 30% amplitude
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

console.log(`phase7-stt-smoke  ARGOS_ROOT=${ARGOS_ROOT}  port=${PORT}`);

let server = null;

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
    console.log(`  STT: available=${j?.stt?.available}  reason=${j?.stt?.reason ?? "ready"}`);
    console.log(`  TTS: available=${j?.tts?.available}  reason=${j?.tts?.reason ?? "ready"}`);
    check("STT capability detected", j?.stt?.available === true);
    // Note: TTS may legitimately be unavailable if kokoros binary not installed
  }

  // === STT round-trip with synthetic tone WAV ===
  console.log("\n=== STT round-trip — 2s 440Hz tone WAV ===");
  const wav = buildToneWav(2, 16000, 440);
  const t0 = Date.now();
  const sttRes = await req("/api/voice/stt", {
    method: "POST",
    headers: { "content-type": "audio/wav", "content-length": String(wav.length) },
    body: wav,
    timeoutMs: 180_000,
  });
  const elapsed = Date.now() - t0;
  check("STT route reachable", sttRes.ok);
  if (sttRes.ok) {
    check("STT route 200", sttRes.res.status === 200,
      sttRes.res.status !== 200 ? `(got ${sttRes.res.status}: ${sttRes.res.text().slice(0, 200)})` : "");
    if (sttRes.res.status === 200) {
      const j = await sttRes.res.json();
      check("STT response has text field", typeof j?.text === "string");
      check("STT response has modelBasename", typeof j?.modelBasename === "string",
        j?.modelBasename ? `(${j.modelBasename})` : "");
      check("STT response has durationMs > 0",
        typeof j?.durationMs === "number" && j.durationMs > 0,
        j?.durationMs ? `(${j.durationMs}ms whisper-cli; ${elapsed}ms wall)` : "");
      check("STT response has audioBytes matching", j?.audioBytes === wav.length,
        `expected ${wav.length}, got ${j?.audioBytes}`);
      console.log(`     transcript: "${(j?.text ?? "").trim().slice(0, 200)}"`);
      console.log(`     wall time: ${elapsed}ms · whisper: ${j?.durationMs}ms · model: ${j?.modelBasename}`);
    }
  }

  // === Audit verification ===
  // The audit append is `void fire-and-forget` from /api/voice/stt
  // (Phase 5 doctrine: audit never blocks the underlying voice op).
  // The microtask may not have flushed by the time the route returned;
  // retry up to 3 times with a short backoff before declaring fail.
  console.log("\n=== audit chain (voice.transcribed event) ===");
  let transcribed = null;
  for (let attempt = 1; attempt <= 3 && !transcribed; attempt++) {
    const rec = await req("/api/receipts?tail=10");
    if (rec.ok && rec.res.status === 200) {
      const j = await rec.res.json();
      const lastEntries = j?.entries ?? [];
      transcribed = lastEntries.find((e) => e.kind === "voice.transcribed");
    }
    if (!transcribed && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  check("voice.transcribed audit entry present", !!transcribed);
  if (transcribed) {
    console.log(`     idx ${transcribed.index} · charCount=${transcribed.payload?.charCount} · audioBytes=${transcribed.payload?.audioBytes} · modelBasename=${transcribed.payload?.modelBasename}`);
  }

  // === TTS round-trip (only meaningful when kokoros installed) ===
  console.log("\n=== TTS check — depends on kokoros binary ===");
  const ttsCheck = await req("/api/voice/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello.", personaId: "bartimaeus" }),
  });
  if (ttsCheck.ok && ttsCheck.res.status === 200) {
    const buf = Buffer.from((await ttsCheck.res.text()), "binary");
    check("TTS roundtrip returns WAV (kokoros installed)",
      ttsCheck.res.headers.get("content-type")?.includes("audio/wav"));
    console.log(`     ${ttsCheck.res.headers.get("x-voice-name")} voice · ${ttsCheck.res.headers.get("x-voice-duration-ms")}ms synth`);
  } else if (ttsCheck.ok && ttsCheck.res.status === 503) {
    const j = await ttsCheck.res.json();
    check("TTS gracefully 503s when kokoros not installed (with hint)", !!j?.hint);
    console.log(`     hint: ${j.hint}`);
  } else {
    fail++;
    console.log(`  [FAIL] TTS returned unexpected ${ttsCheck.res?.status}`);
  }

} catch (e) {
  fail++;
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
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
const verdict = fail === 0
  ? `phase7-stt-smoke: ${pass} passed — PASS`
  : `phase7-stt-smoke: ${pass} passed, ${fail} failed — FAIL`;
console.log(verdict);
process.exit(fail === 0 ? 0 : 1);
