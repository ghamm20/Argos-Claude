// app/api/vision/status/route.ts
//
// Vision Phase 1 (2026-06-02) — capability snapshot + a deterministic routing
// probe.
//
//   GET  → { ok, vision, model, available, features, ollamaBase }
//          `available` = the vision model is pulled in the local Ollama.
//          Always 200 (never error) so the UI reads flags safely.
//
//   POST → routing probe. Body: { hasImages?, messages?, personaModel }.
//          Returns { model, vision } from the SAME resolveChatModel used by
//          /api/chat, with NO Ollama call — so the smoke can assert routing
//          deterministically (image → vision model, text → persona model).

import { NextResponse } from "next/server";
import {
  getVisionModel,
  visionModelAvailable,
  messagesHaveImages,
  resolveChatModel,
  VISION_FEATURES,
} from "@/lib/vision";
import { getOllamaBase } from "@/lib/ollama-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const model = getVisionModel();
  let available = false;
  try {
    available = await visionModelAvailable();
  } catch {
    available = false;
  }
  return NextResponse.json({
    ok: true,
    vision: available ? "live" : "model-missing",
    model,
    available,
    features: VISION_FEATURES,
    ollamaBase: getOllamaBase(),
  });
}

export async function POST(req: Request) {
  let body: {
    hasImages?: boolean;
    messages?: Array<{ images?: unknown }>;
    personaModel?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const personaModel =
    typeof body.personaModel === "string" && body.personaModel.trim()
      ? body.personaModel
      : "persona-model-placeholder";
  // hasImages can be given directly OR inferred from a messages array — both
  // exercise the production routing helpers.
  const hasImages =
    body.hasImages === true ? true : messagesHaveImages(body.messages);
  const { model, vision } = resolveChatModel({ hasImages, personaModel });
  return NextResponse.json({ ok: true, model, vision, hasImages });
}
