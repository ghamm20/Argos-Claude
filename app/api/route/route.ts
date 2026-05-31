// app/api/route/route.ts
//
// Phase 9 (2026-05-31) — persona router test/utility endpoint.
//
//   POST /api/route
//   Body: { query: string, useModel?: boolean, model?: string }
//
//   200 application/json — RouteResult (recommended, confidence, ...)
//   400 — bad request (missing/oversized query)
//
// Default is keyword-only (deterministic, zero-latency, no Ollama
// touched) so the smoke test is reproducible. Pass useModel:true to
// exercise the Ollama fallback for low-confidence queries; the model
// defaults to settings.defaultModel when omitted.
//
// SUGGESTION ONLY: this endpoint never changes any persona state. It's
// a pure classifier surface for the client + smoke harness.

import { NextRequest, NextResponse } from "next/server";
import {
  routePersona,
  ROUTE_CONFIDENCE_THRESHOLD,
} from "@/lib/persona-router";
import { getOllamaBase } from "@/lib/ollama-config";
import { readSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY = 4_000;

export async function POST(req: NextRequest) {
  let body: { query?: string; useModel?: boolean; model?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    return NextResponse.json(
      { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }

  const query = typeof body.query === "string" ? body.query : "";
  if (!query.trim()) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }
  if (query.length > MAX_QUERY) {
    return NextResponse.json(
      { error: `query too long (${query.length} > ${MAX_QUERY})` },
      { status: 400 }
    );
  }

  const useModel = body.useModel === true;
  let model = typeof body.model === "string" ? body.model : undefined;
  if (useModel && !model) {
    // Default to the configured boot model so callers don't have to
    // know it. Best-effort; if settings can't be read we just skip the
    // fallback (routePersona stays keyword-only when model is absent).
    try {
      const s = await readSettings();
      model = s.defaultModel;
    } catch {
      /* leave model undefined → keyword-only */
    }
  }

  // routePersona is total (never throws). Wrap anyway for belt+braces.
  try {
    const result = await routePersona(query, {
      useModel,
      model,
      ollamaBase: getOllamaBase(),
    });
    return NextResponse.json({
      ...result,
      threshold: ROUTE_CONFIDENCE_THRESHOLD,
      surface: result.recommended !== null &&
        result.confidence >= ROUTE_CONFIDENCE_THRESHOLD,
    });
  } catch (e) {
    // Should be unreachable; degrade to a safe "stay put".
    return NextResponse.json({
      recommended: null,
      confidence: 0,
      method: "none",
      complexity: "low",
      scores: { bartimaeus: 0, juniper: 0, sage: 0, bobby: 0 },
      reason: `router error (degraded): ${e instanceof Error ? e.message : String(e)}`,
      threshold: ROUTE_CONFIDENCE_THRESHOLD,
      surface: false,
    });
  }
}

export async function GET() {
  return NextResponse.json({
    method: "POST application/json { query, useModel?, model? }",
    threshold: ROUTE_CONFIDENCE_THRESHOLD,
    personas: ["bartimaeus", "juniper", "sage", "bobby"],
  });
}
