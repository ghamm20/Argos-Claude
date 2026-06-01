// app/api/voice/status/route.ts
//
// Phase 5 — voice capability snapshot for the UI to decide whether
// to show mic / play buttons. Cheap (no spawn, only stat). UI polls
// on mount + on settings tab open. Always returns 200 (never error)
// so the client logic can read `available` flags safely.

import { NextResponse } from "next/server";
import { detectVoiceCapability } from "@/lib/voice";
import { f5Status } from "@/lib/voice-f5";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cap = await detectVoiceCapability();
    // Phase 7-C: F5-TTS Bartimaeus clone status (cheap, stat-only). When
    // available, Bartimaeus TTS uses F5; all other personas use Piper.
    return NextResponse.json({ ...cap, f5: f5Status() });
  } catch (e) {
    // detectVoiceCapability does its own fs work — wrap in case
    // the cache dir is unreadable. Still return 200 so the UI knows
    // voice is just "off" rather than treating it as a server error.
    return NextResponse.json({
      stt: {
        available: false,
        binary: null,
        model: null,
        reason: `capability probe failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      tts: {
        available: false,
        binary: null,
        model: null,
        voices: null,
        reason: `capability probe failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      argosRoot: process.env.ARGOS_ROOT ?? null,
      toolsDir: null,
      f5: { available: false, reason: "capability probe failed" },
    });
  }
}
