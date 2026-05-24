// app/api/voice/status/route.ts
//
// Phase 5 — voice capability snapshot for the UI to decide whether
// to show mic / play buttons. Cheap (no spawn, only stat). UI polls
// on mount + on settings tab open. Always returns 200 (never error)
// so the client logic can read `available` flags safely.

import { NextResponse } from "next/server";
import { detectVoiceCapability } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cap = await detectVoiceCapability();
    return NextResponse.json(cap);
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
    });
  }
}
