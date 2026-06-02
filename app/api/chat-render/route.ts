// app/api/chat-render/route.ts
//
// Diagnostic endpoint for the chat-render cleanups (2026-06-02). Exercises the
// SAME pure helpers the client uses so a smoke can assert behavior without a
// browser. No model, no side effects. Always 200.
//
//   GET  /api/chat-render?text=...
//   POST /api/chat-render        { text }
//
// Returns: { stripped, answer, reasoning }

import { NextResponse } from "next/server";
import { stripToolTags, splitReasoning } from "@/lib/chat-render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function render(text: string) {
  const stripped = stripToolTags(text);
  const { answer, reasoning } = splitReasoning(stripped);
  return { ok: true, stripped, answer, reasoning };
}

export async function GET(req: Request) {
  const text = new URL(req.url).searchParams.get("text") ?? "";
  return NextResponse.json(render(text));
}

export async function POST(req: Request) {
  let text = "";
  try {
    const body = (await req.json()) as { text?: string };
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    /* empty body → empty text */
  }
  return NextResponse.json(render(text));
}
