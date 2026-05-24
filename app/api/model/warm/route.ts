// app/api/model/warm/route.ts
//
// Phase 2-RB — model warm endpoint.
//
//   POST /api/model/warm
//   Body: { model: string }
//
// Forces Ollama to load the named model (or no-op if already loaded).
// Returns 200 when load completes, plus load_duration_ms from Ollama
// so the UI can show real timings. Returns 404 if model isn't in the
// Ollama store, 400 if model name isn't in our AVAILABLE_MODELS, 502
// if Ollama is unreachable.
//
// Used by store.switchPersona to drive the visible "Loading <persona>…
// → Model ready / failed" UX state. Also useful for /api/health-style
// preflights if a future endpoint needs them.

import { NextRequest, NextResponse } from "next/server";
import { isAvailableModel, AVAILABLE_MODELS } from "@/lib/store";
import { getOllamaBase } from "@/lib/ollama-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WarmBody {
  model?: string;
}

export async function POST(req: NextRequest) {
  let body: WarmBody;
  try {
    body = (await req.json()) as WarmBody;
  } catch (e) {
    return NextResponse.json(
      { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }
  const model = body.model?.trim();
  if (!model) {
    return NextResponse.json({ error: "model is required" }, { status: 400 });
  }
  if (!isAvailableModel(model)) {
    return NextResponse.json(
      {
        error: `model not in AVAILABLE_MODELS: ${model}`,
        availableModels: AVAILABLE_MODELS,
      },
      { status: 400 }
    );
  }

  const base = getOllamaBase();
  // /api/generate with an empty prompt + keep_alive forces the model
  // to load into memory (or no-ops if already resident). Faster than
  // running a real prompt; documented Ollama behavior.
  const t0 = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        stream: false,
        keep_alive: "60m",
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timed out/i.test(msg)) {
      return NextResponse.json(
        { error: `model warm timed out after 120s: ${model}` },
        { status: 504 }
      );
    }
    if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      return NextResponse.json(
        {
          error: `Ollama not reachable at ${base}. Is \`ollama serve\` running?`,
        },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    if (upstream.status === 404 || /not found|no such model/i.test(txt)) {
      return NextResponse.json(
        {
          error: `model not found in Ollama store: ${model}`,
          hint: `Run: ollama pull ${model}`,
          ollamaBody: txt,
        },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { error: `ollama error ${upstream.status}`, ollamaBody: txt },
      { status: upstream.status }
    );
  }

  // Ollama returns { load_duration, total_duration, done_reason, ... }
  // on a no-prompt /api/generate. We surface the durations so the UI
  // can report real times.
  const j = await upstream.json().catch(() => ({}));
  const wallMs = Date.now() - t0;
  return NextResponse.json({
    ok: true,
    model,
    wallMs,
    loadDurationMs: j.load_duration ? j.load_duration / 1e6 : null,
    totalDurationMs: j.total_duration ? j.total_duration / 1e6 : null,
    doneReason: j.done_reason ?? null,
  });
}
