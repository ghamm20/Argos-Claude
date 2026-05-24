// app/api/voice/stt/route.ts
//
// Phase 5 — speech-to-text endpoint.
//
//   POST /api/voice/stt
//   Content-Type: audio/wav
//   Body: 16kHz mono PCM WAV (browser encodes via AudioContext;
//         see lib/voice-client.ts on the client side)
//
// Response:
//   { text, durationMs, modelBasename, audioBytes }
//
// On capability miss (no binary / no model):
//   503 { error, hint: "open tools/voice/README.md" }
//
// On transcribe failure (binary spawn error / non-zero exit):
//   500 { error, stderr }
//
// Audit chain: `voice.transcribed` entry on success, best-effort
// (never blocks the response).

import { NextRequest, NextResponse } from "next/server";
import { transcribeWav, detectVoiceCapability } from "@/lib/voice";
import { appendAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard cap on inbound audio size. 16kHz mono 16-bit PCM = 32 KB/s,
// so 25 MB ≈ 13 minutes — plenty for voice notes; well under the
// "operator forgot they were recording" disaster scenario.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  // Capability gate. Avoids spinning up the spawn pipeline only to
  // fail mid-stream when the binary is missing.
  const cap = await detectVoiceCapability();
  if (!cap.stt.available) {
    return NextResponse.json(
      {
        error: "voice STT not available",
        hint: cap.stt.reason ?? "see tools/voice/README.md",
      },
      { status: 503 }
    );
  }

  // Stream-collect body. Next.js Request.arrayBuffer respects the
  // server's body-size limits; we add our own cap for early bail.
  let wav: Buffer;
  try {
    const ab = await req.arrayBuffer();
    if (ab.byteLength === 0) {
      return NextResponse.json({ error: "empty audio body" }, { status: 400 });
    }
    if (ab.byteLength > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        {
          error: `audio too large (${ab.byteLength} bytes > ${MAX_AUDIO_BYTES} cap)`,
        },
        { status: 413 }
      );
    }
    wav = Buffer.from(ab);
  } catch (e) {
    return NextResponse.json(
      {
        error: `failed to read body: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 400 }
    );
  }

  // Optional query params:
  //   ?lang=en       — language hint
  //   ?sessionId=ID  — for audit chain scoping
  const url = new URL(req.url);
  const lang = url.searchParams.get("lang") || undefined;
  const sessionId = url.searchParams.get("sessionId") || undefined;

  try {
    const result = await transcribeWav(wav, { language: lang });

    // Audit chain — best-effort. Failure here MUST NOT mask the
    // successful transcription. Console log is enough.
    void appendAudit(
      "voice.transcribed",
      {
        durationMs: result.durationMs,
        charCount: result.text.length,
        audioBytes: result.audioBytes,
        modelBasename: result.modelBasename,
        language: lang ?? null,
      },
      { sessionId }
    ).catch((e) =>
      console.warn("[voice/stt] audit append failed:", (e as Error).message)
    );

    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
