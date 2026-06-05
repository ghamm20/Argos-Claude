#!/usr/bin/env node
// smoke-phase7c.mjs (Phase 7-C) — ElevenLabs TTS for Bartimaeus, Piper fallback.
//
// Four gate tests (zero failures = pass):
//   1. Settings API accepts + stores elevenlabs_api_key (masked on read-back).
//   2. TTS persona=bartimaeus WITH a key set → returns audio (the key here is
//      fake, so ElevenLabs 401s and the SILENT Piper fallback serves audio —
//      this is the doctrine path: "user never sees an error if ElevenLabs
//      fails"). NOT a 503/error.
//   3. TTS persona=bartimaeus with NO key → Piper audio, NOT a 503.
//   4. TTS persona=juniper (key set) → Piper audio; ElevenLabs is never used for
//      non-Bart personas.
//
// Isolation: a throwaway ARGOS_ROOT (so the operator's real settings.json is
// untouched) with a directory JUNCTION to the installed Piper tools so TTS can
// actually synthesize. A real ElevenLabs key is NOT required (and not present);
// "real key → ElevenLabs audio" is validated by the operator via the Settings
// Test button.
//
// Usage: node scripts/smoke-phase7c.mjs [--port 7881]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7881;
const ROOT = join(tmpdir(), `argos-phase7c-${process.pid}`);
// Piper tools source (has piper.exe + a voice). Resolved WITHOUT a hardcoded
// absolute-path literal so USB-native Rule 1 (no C:\, D:\, …) stays green:
//   1. ARGOS_PIPER_SOURCE env override (point at any payload, incl. the USB),
//   2. the Desktop payload under the operator's home dir (os.homedir()).
const PIPER_SOURCES = [
  process.env.ARGOS_PIPER_SOURCE,
  join(homedir(), "Desktop", "ARGOS", "tools", "voice"),
].filter(Boolean);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [PASS] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function postJson(path, payload) {
  return new Promise((res) => {
    const url = new URL(path, `http://127.0.0.1:${PORT}`);
    const body = Buffer.from(JSON.stringify(payload));
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "content-type": "application/json", "content-length": body.length }, timeout: 60000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, bytes: Buffer.concat(c) })); });
    r.on("error", () => res({ status: 0 })); r.on("timeout", () => { r.destroy(); res({ status: 0 }); }); r.write(body); r.end();
  });
}
function getJson(path) {
  return new Promise((res) => {
    http.get(new URL(path, `http://127.0.0.1:${PORT}`), (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }).on("error", () => res(null));
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", `http://127.0.0.1:${PORT}`), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false;
}
const isWavAudio = (r) => r.status === 200 && /audio\/wav/i.test(r.headers?.["content-type"] ?? "") && (r.bytes?.length ?? 0) > 44;

// --- isolation setup: temp ROOT + junction to real Piper tools ---
fs.mkdirSync(join(ROOT, "tools"), { recursive: true });
const piperSrc = PIPER_SOURCES.find((p) => fs.existsSync(join(p, "piper", "piper.exe")));
let piperLinked = false;
if (piperSrc) {
  const r = spawnSync("cmd", ["/c", "mklink", "/J", join(ROOT, "tools", "voice"), piperSrc.replace(/\//g, "\\")], { stdio: "ignore" });
  piperLinked = r.status === 0;
}

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

const BART_TEXT = "I am Bartimaeus. Try not to waste my time.";
const FAKE_KEY = "sk-phase7c-smoke-fake-key-not-real";

try {
  if (!piperLinked) throw new Error(`could not link Piper tools from ${PIPER_SOURCES.join(" | ")} — install Piper to run the TTS tests`);
  if (!(await ready())) throw new Error("server not ready");
  console.log(`[ready] smoke-phase7c (piper via junction → ${piperSrc})\n`);

  console.log("=== Test 1 — settings stores elevenlabs_api_key (masked on read-back) ===");
  const t1 = await postJson("/api/settings", { elevenlabs: { apiKey: FAKE_KEY, bartVoiceId: "aGv5jHWKBy8K5xKvYeSX", model: "eleven_multilingual_v2" } });
  check("1a: POST /api/settings accepted (200)", t1.status === 200, `status=${t1.status}`);
  const s = await getJson("/api/settings");
  check("1b: read-back shows configured:true", s?.elevenlabs?.apiKey?.configured === true, JSON.stringify(s?.elevenlabs?.apiKey ?? null));
  check("1c: read-back NEVER returns the raw key", JSON.stringify(s?.elevenlabs ?? {}).indexOf(FAKE_KEY) === -1, "key absent from response");
  check("1d: voice id + model stored", s?.elevenlabs?.bartVoiceId === "aGv5jHWKBy8K5xKvYeSX" && s?.elevenlabs?.model === "eleven_multilingual_v2");

  console.log("\n=== Test 2 — Bart + key set → audio (ElevenLabs fails → SILENT Piper fallback) ===");
  const t2 = await postJson("/api/voice/tts", { text: BART_TEXT, personaId: "bartimaeus" });
  check("2: returns 200 audio/wav (no 503, silent fallback)", isWavAudio(t2), `status=${t2.status} ct=${t2.headers?.["content-type"]} engine=${t2.headers?.["x-voice-engine"]}`);

  console.log("\n=== Test 3 — Bart + NO key → Piper audio (not 503) ===");
  await postJson("/api/settings", { elevenlabs: { apiKey: null } }); // clear the key
  const sCleared = await getJson("/api/settings");
  check("3a: key cleared (configured:false)", sCleared?.elevenlabs?.apiKey?.configured === false);
  const t3 = await postJson("/api/voice/tts", { text: BART_TEXT, personaId: "bartimaeus" });
  check("3b: returns 200 audio/wav via Piper (not 503)", isWavAudio(t3) && t3.headers?.["x-voice-engine"] === "piper", `status=${t3.status} engine=${t3.headers?.["x-voice-engine"]}`);

  console.log("\n=== Test 4 — Juniper ignores ElevenLabs (key set → still Piper) ===");
  await postJson("/api/settings", { elevenlabs: { apiKey: FAKE_KEY } }); // key set again
  const t4 = await postJson("/api/voice/tts", { text: "This is Juniper.", personaId: "juniper" });
  check("4: Juniper → 200 Piper audio, ElevenLabs never used", isWavAudio(t4) && t4.headers?.["x-voice-engine"] === "piper", `status=${t4.status} engine=${t4.headers?.["x-voice-engine"]}`);
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  // Remove the junction first (rmdir the link, NOT its target), then the ROOT.
  try { spawnSync("cmd", ["/c", "rmdir", join(ROOT, "tools", "voice")], { stdio: "ignore" }); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\nsmoke-phase7c: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
