#!/usr/bin/env node
// smoke-voice.mjs — Phase 5 voice subsystem smoke.
//
// Two layers:
//
//   LAYER A — scaffold checks (always run; no binaries required)
//     A1. /api/voice/status returns a well-formed capability snapshot
//     A2. /api/voice/stt 503s with `hint` when binary missing
//     A3. /api/voice/tts 503s with `hint` when binary missing
//     A4. /api/voice/tts GET returns default voice metadata
//     A5. lib/voice.ts: paths derive from ARGOS_ROOT (Rule 5)
//     A6. lib/voice.ts: WAV cap enforced (>25 MB → 413)
//     A7. lib/voice.ts: TTS empty body rejected
//     A8. audit kinds `voice.transcribed` + `voice.spoken` declared
//
//   LAYER B — roundtrip (skipped unless binaries + models present)
//     B1. POST WAV → STT → text round-trip
//     B2. POST text → TTS → WAV round-trip
//     B3. audit chain gained one of each kind
//
// The smoke can be run two ways:
//   * Against a running ARGOS server (default): set ARGOS_URL env var
//     to override (default http://127.0.0.1:7799)
//   * Self-contained: pass --no-http to skip the HTTP-dependent
//     checks (still verifies file-shape / type-shape via imports)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const ARGOS_URL = process.env.ARGOS_URL || "http://127.0.0.1:7799";
const NO_HTTP = process.argv.includes("--no-http");

// node:http with a no-keepalive agent. Using node's fetch (undici)
// has surfaced a libuv UV_HANDLE_CLOSING assertion during process
// teardown on Windows node 24 — avoidable by sticking to http.request
// + agent.destroy() at end of smoke. Same wire protocol, no surprises.
const httpAgent = new http.Agent({ keepAlive: false });

let pass = 0;
let fail = 0;
let skipped = 0;
function check(label, cond, detail = "") {
  const tag = cond ? "[ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (cond) pass++;
  else fail++;
}
function skip(label, reason) {
  console.log(`  [skip] ${label}  ${reason}`);
  skipped++;
}

async function fetchSafe(path, opts = {}) {
  return new Promise((resolveResult) => {
    let url;
    try {
      url = new URL(path, ARGOS_URL);
    } catch (e) {
      resolveResult({ ok: false, error: `bad URL: ${e.message}` });
      return;
    }
    const req = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
        agent: httpAgent,
        timeout: 30_000,
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
              headers: { get: (h) => res.headers[h.toLowerCase()] ?? null },
              text: async () => body.toString("utf8"),
              json: async () => JSON.parse(body.toString("utf8")),
              arrayBuffer: async () =>
                body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
            },
          });
        });
      }
    );
    req.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    if (opts.body) {
      if (typeof opts.body === "string") req.write(opts.body);
      else req.write(Buffer.from(opts.body));
    }
    req.end();
  });
}

// =============== LAYER A — scaffold ===============

console.log("=== Layer A: scaffold checks (always run) ===");

// A5 — derive-from-ARGOS_ROOT check via static file read
{
  const src = readFileSync(join(ROOT, "lib", "voice.ts"), "utf8");
  const hasArgosRoot = src.includes("argosRoot()");
  const hasHardcodedAbs = /(["'])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/.test(src);
  check("A5  lib/voice.ts uses argosRoot()", hasArgosRoot);
  check("A5  lib/voice.ts contains no hardcoded absolute path literals", !hasHardcodedAbs);
}

// A8 — audit kinds declared
{
  const auditSrc = readFileSync(join(ROOT, "lib", "audit.ts"), "utf8");
  check(
    "A8  audit kind 'voice.transcribed' declared",
    /['"]voice\.transcribed['"]/.test(auditSrc)
  );
  check(
    "A8  audit kind 'voice.spoken' declared",
    /['"]voice\.spoken['"]/.test(auditSrc)
  );
}

// File presence checks (cheap)
{
  for (const f of [
    "app/api/voice/status/route.ts",
    "app/api/voice/stt/route.ts",
    "app/api/voice/tts/route.ts",
    "components/voice/MicButton.tsx",
    "components/voice/PlayButton.tsx",
    "lib/voice.ts",
    "lib/voice-client.ts",
    "docs/VOICE.md",
  ]) {
    check(`source present: ${f}`, existsSync(join(ROOT, f)));
  }
}

// HTTP-dependent scaffold checks
if (NO_HTTP) {
  console.log("");
  console.log("=== Skipping HTTP checks (--no-http) ===");
} else {
  console.log("");
  console.log(`=== Layer A (HTTP) — server at ${ARGOS_URL} ===`);

  // A1
  const s = await fetchSafe("/api/voice/status");
  if (!s.ok) {
    skip("A1–A4 HTTP smoke", `server unreachable: ${s.error}`);
  } else {
    const status = s.res;
    check("A1  /api/voice/status returns 200", status.status === 200);
    let body;
    try {
      body = await status.json();
    } catch {
      body = null;
    }
    check("A1  /api/voice/status returns JSON body", !!body);
    if (body) {
      check(
        "A1  status body has stt.available boolean",
        typeof body?.stt?.available === "boolean"
      );
      check(
        "A1  status body has tts.available boolean",
        typeof body?.tts?.available === "boolean"
      );
      check(
        "A1  status body reports argosRoot",
        typeof body?.argosRoot === "string" && body.argosRoot.length > 0
      );

      const sttAvail = !!body.stt.available;
      const ttsAvail = !!body.tts.available;

      // A2 — STT 503 path
      if (!sttAvail) {
        const sttRes = await fetchSafe("/api/voice/stt", {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF; not valid WAV but body is non-empty
        });
        check("A2  STT 503s when binary missing", sttRes.ok && sttRes.res.status === 503);
        if (sttRes.ok) {
          const j = await sttRes.res.json().catch(() => null);
          check("A2  STT 503 body includes hint", !!j?.hint);
        }
      } else {
        skip("A2  STT 503 path", "binary IS installed — roundtrip will run instead");
      }

      // A3 — TTS 503 path
      if (!ttsAvail) {
        const ttsRes = await fetchSafe("/api/voice/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        });
        check("A3  TTS 503s when binary missing", ttsRes.ok && ttsRes.res.status === 503);
        if (ttsRes.ok) {
          const j = await ttsRes.res.json().catch(() => null);
          check("A3  TTS 503 body includes hint", !!j?.hint);
        }
      } else {
        skip("A3  TTS 503 path", "binary IS installed — roundtrip will run instead");
      }

      // A4 — TTS GET metadata
      const ttsGet = await fetchSafe("/api/voice/tts");
      check("A4  TTS GET returns 200", ttsGet.ok && ttsGet.res.status === 200);
      if (ttsGet.ok) {
        const j = await ttsGet.res.json().catch(() => null);
        check(
          "A4  TTS GET reports defaultVoice",
          typeof j?.defaultVoice === "string" && j.defaultVoice.length > 0
        );
      }

      // A6 — oversize WAV → 413
      // Only meaningful if STT path is reachable (capability-gate trumps size-gate).
      if (sttAvail) {
        const huge = Buffer.alloc(26 * 1024 * 1024);
        const big = await fetchSafe("/api/voice/stt", {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: huge,
        });
        check(
          "A6  STT rejects >25 MB body with 413",
          big.ok && big.res.status === 413
        );
      } else {
        skip("A6  >25 MB → 413 check", "STT unavailable; size-gate isn't reachable");
      }

      // A7 — TTS empty text → 400
      if (ttsAvail) {
        const empty = await fetchSafe("/api/voice/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "" }),
        });
        check("A7  TTS empty text → 400", empty.ok && empty.res.status === 400);
      } else {
        skip("A7  empty-text 400", "TTS unavailable; can't reach validation");
      }

      // =============== LAYER B — roundtrip ===============
      console.log("");
      console.log("=== Layer B: roundtrip checks (require installed binaries) ===");

      // B1 — STT roundtrip with a 1s silent WAV. Whisper will return
      // empty or a short hallucination; we just check it doesn't crash.
      if (sttAvail) {
        const silence = buildSilenceWav(16000, 1); // 1s of silence
        const rt = await fetchSafe("/api/voice/stt", {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: silence,
        });
        check("B1  STT roundtrip returns 200", rt.ok && rt.res.status === 200);
        if (rt.ok) {
          const j = await rt.res.json().catch(() => null);
          check("B1  STT roundtrip body has text field", typeof j?.text === "string");
          check(
            "B1  STT roundtrip durationMs > 0",
            typeof j?.durationMs === "number" && j.durationMs > 0
          );
        }
      } else {
        skip("B1  STT roundtrip", "whisper binary or model missing");
      }

      // B2 — TTS roundtrip with a short greeting
      if (ttsAvail) {
        const ttsRT = await fetchSafe("/api/voice/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello from ARGOS" }),
        });
        check("B2  TTS roundtrip returns 200", ttsRT.ok && ttsRT.res.status === 200);
        if (ttsRT.ok && ttsRT.res.status === 200) {
          const buf = Buffer.from(await ttsRT.res.arrayBuffer());
          check(
            "B2  TTS roundtrip body starts with RIFF header",
            buf.length > 44 && buf.slice(0, 4).toString() === "RIFF"
          );
          check(
            "B2  TTS x-voice-engine header is kokoro",
            ttsRT.res.headers.get("x-voice-engine") === "kokoro"
          );
        }
      } else {
        skip("B2  TTS roundtrip", "kokoro binary or model missing");
      }

      // B3 — audit chain check (best-effort; chain might have other entries too)
      if (sttAvail || ttsAvail) {
        const rec = await fetchSafe("/api/receipts?tail=20");
        if (rec.ok && rec.res.status === 200) {
          const j = await rec.res.json().catch(() => null);
          const entries = Array.isArray(j?.entries) ? j.entries : [];
          const kinds = new Set(entries.map((e) => e.kind));
          if (sttAvail) {
            check(
              "B3  audit chain saw 'voice.transcribed'",
              kinds.has("voice.transcribed")
            );
          }
          if (ttsAvail) {
            check("B3  audit chain saw 'voice.spoken'", kinds.has("voice.spoken"));
          }
        } else {
          skip("B3  audit chain check", "receipts endpoint unreachable");
        }
      } else {
        skip("B3  audit chain check", "no roundtrip ran");
      }
    }
  }
}

console.log("");
const summary = `smoke-voice: ${pass} passed, ${fail} failed, ${skipped} skipped`;
console.log(fail === 0 ? summary + "  — PASS" : summary + "  — FAIL");
// Explicit agent teardown — the no-keepalive setting prevents
// most lingering sockets, but be deterministic.
httpAgent.destroy();
process.exit(fail === 0 ? 0 : 1);

// ----- helpers --------------------------------------------------

function buildSilenceWav(sampleRate, seconds) {
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // Samples are zeros already (Buffer.alloc).
  return buf;
}
