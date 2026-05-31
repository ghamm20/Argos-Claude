// app/api/heartbeat/trigger/route.ts
//
// Phase 10 Heartbeat (2026-05-31) — manual immediate trigger.
//
//   POST /api/heartbeat/trigger
//   Body (optional): { mockResponse?: string }
//     - mockResponse: TEST HOOK. When provided, the triage model is
//       bypassed and this string is used as the model reply, so the
//       smoke can exercise the OK-suppress and actionable-alert paths
//       deterministically without a live model.
//
//   200 → the HeartbeatResult for this tick.
//
// Runs a single tick immediately (source: "manual"), bypassing the
// interval AND the disabled-gate (so the operator can test a tick even
// before enabling the schedule). Honors the in-flight gate. Never
// fires an alert unless the triage result is genuinely actionable AND
// Pushover credentials are configured.

import { NextRequest, NextResponse } from "next/server";
import { runHeartbeatTick } from "@/lib/heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { mockResponse?: string } = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as { mockResponse?: string };
    }
  } catch {
    // Tolerate empty / malformed body — just run a normal tick.
    body = {};
  }

  // runHeartbeatTick is total (never throws). Belt + braces anyway.
  try {
    const result = await runHeartbeatTick({
      source: "manual",
      triageOverride:
        typeof body.mockResponse === "string" ? body.mockResponse : undefined,
    });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `trigger failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 }
    );
  }
}
