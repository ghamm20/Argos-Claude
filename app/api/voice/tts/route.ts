// app/api/voice/tts/route.ts
//
// Phase 5 — text-to-speech endpoint.
//
//   POST /api/voice/tts
//   Content-Type: application/json
//   Body: { text: string, voice?: string, speed?: number, sessionId?: string }
//
// Response:
//   200 audio/wav  — synthesized WAV bytes (browser plays via <audio>)
//   503 application/json — voice not configured (binary/model missing)
//   400 application/json — bad request (empty/too-long text)
//   500 application/json — synth failed
//
// Audit chain: `voice.spoken` entry on success, best-effort.

import { NextRequest, NextResponse } from "next/server";
import {
  synthesizeText,
  detectVoiceCapability,
  DEFAULT_KOKORO_VOICE,
} from "@/lib/voice";
import { appendAudit } from "@/lib/audit";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SynthRequest {
  text?: string;
  voice?: string;
  speed?: number;
  sessionId?: string;
  /** Phase 7: if set, pulls voiceId from the persona unless `voice` overrides */
  personaId?: PersonaId;
}

export async function POST(req: NextRequest) {
  // Capability gate
  const cap = await detectVoiceCapability();
  if (!cap.tts.available) {
    return NextResponse.json(
      {
        error: "voice TTS not available",
        hint: cap.tts.reason ?? "see tools/voice/README.md",
      },
      { status: 503 }
    );
  }

  let body: SynthRequest;
  try {
    body = (await req.json()) as SynthRequest;
  } catch (e) {
    return NextResponse.json(
      {
        error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 400 }
    );
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  // Phase 7: resolve voice — explicit `voice` arg wins; else fall back
  // to the persona's `voiceId` (if a `personaId` is included); else null
  // → synthesizeText() uses DEFAULT_KOKORO_VOICE.
  let resolvedVoice = body.voice;
  if (!resolvedVoice && body.personaId) {
    const persona = PERSONA_BY_ID[body.personaId];
    if (persona?.voiceId) resolvedVoice = persona.voiceId;
  }

  try {
    const result = await synthesizeText(text, {
      voice: resolvedVoice,
      speed: body.speed,
    });

    void appendAudit(
      "voice.spoken",
      {
        charCount: result.charCount,
        voice: result.voice,
        durationMs: result.durationMs,
        audioBytes: result.wav.length,
      },
      { sessionId: body.sessionId }
    ).catch((e) =>
      console.warn("[voice/tts] audit append failed:", (e as Error).message)
    );

    // Return the WAV body directly. The browser <audio> element
    // happily plays a Blob from this. Content-Length lets the
    // browser preallocate the buffer for smoother first-play.
    return new NextResponse(result.wav, {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-length": String(result.wav.length),
        "cache-control": "no-store",
        // Echo metadata as headers so a CLI consumer can read them
        // without re-parsing. Custom x- prefix keeps them clearly
        // ARGOS-defined.
        "x-voice-engine": "kokoro",
        "x-voice-name": result.voice,
        "x-voice-duration-ms": String(result.durationMs),
        "x-voice-char-count": String(result.charCount),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Allow the UI to discover the default voice without first calling
// /api/voice/status (which has the same info but is heavier).
export async function GET() {
  return NextResponse.json({
    defaultVoice: DEFAULT_KOKORO_VOICE,
    method: "POST application/json { text, voice?, speed?, sessionId? }",
  });
}
