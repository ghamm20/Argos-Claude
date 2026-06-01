// app/api/dispatch/route.ts
//
// Phase 11 Dispatcher (2026-05-31).
//
//   POST /api/dispatch
//   Body: { type: string, content: string, source?: string, mockResponse?: string }
//     - mockResponse: TEST HOOK — bypasses the model and uses this as the
//       persona's response so the OK-suppress / actionable-alert paths are
//       deterministic in the smoke (no live model required).
//   → 200 { ok, result: DispatchResult }
//
//   GET /api/dispatch → dispatcher status (last event, last persona,
//   counts) for the HUD. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { dispatchEvent, getDispatcherStatus } from "@/lib/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT = 20_000;

export async function POST(req: NextRequest) {
  let body: { type?: string; content?: string; source?: string; mockResponse?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }

  const type = typeof body.type === "string" ? body.type : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!type.trim()) {
    return NextResponse.json({ ok: false, error: "type is required" }, { status: 400 });
  }
  if (!content.trim()) {
    return NextResponse.json({ ok: false, error: "content is required" }, { status: 400 });
  }
  if (content.length > MAX_CONTENT) {
    return NextResponse.json(
      { ok: false, error: `content too long (${content.length} > ${MAX_CONTENT})` },
      { status: 400 }
    );
  }

  // dispatchEvent is total (never throws). Belt + braces anyway.
  try {
    const result = await dispatchEvent(
      { type, content, source: typeof body.source === "string" ? body.source : "manual" },
      { responseOverride: typeof body.mockResponse === "string" ? body.mockResponse : undefined }
    );
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `dispatch failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const status = await getDispatcherStatus();
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json({
      lastEventAt: null,
      lastType: null,
      lastPersona: null,
      lastStatus: null,
      count: 0,
      byPersona: {},
      last: null,
      memoryFile: null,
      skillsDir: null,
      error: `status failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
