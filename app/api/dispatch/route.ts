// app/api/dispatch/route.ts
//
// Phase 11 Dispatcher (2026-05-31) — hardened webhook (Task 4).
//
//   POST /api/dispatch
//   Headers (optional):
//     X-Dispatch-Id: <id>   idempotency key — a repeat within 5 minutes
//                            returns the cached result, does NOT re-dispatch.
//     X-Forwarded-For / X-Real-IP   client IP for per-IP rate limiting.
//   Body: { type, content, source?, mockResponse? }
//     - type:    one of security | research | ops | comms | heartbeat
//     - content: non-empty, ≤ 2000 chars
//     - source:  optional, ≤ 100 chars
//     - mockResponse: TEST HOOK — bypasses the model with this response.
//   → 200 { ok, result: DispatchResult, idempotentReplay? }
//   → 400 invalid input · 429 rate limited
//
//   Hardening order: rate-limit → parse → validate → idempotency → dispatch.
//   Every attempt (success | rate-limited | duplicate | invalid | error) is
//   written to the append-only dispatch audit log.
//
//   GET /api/dispatch → dispatcher status for the HUD. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { dispatchEvent, getDispatcherStatus } from "@/lib/dispatcher";
import {
  checkRateLimit,
  validateDispatchInput,
  getIdempotent,
  storeIdempotent,
  logDispatchAttempt,
  RATE_LIMIT_PER_MIN,
} from "@/lib/dispatch-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Derive a stable rate-limit key from the request. Honors a forwarding
 *  proxy header when present (ARGOS is local-first; the operator's own
 *  network is trusted), else falls back to a shared "local" bucket. */
function clientKey(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff && xff.trim()) return xff.split(",")[0].trim();
  const xri = req.headers.get("x-real-ip");
  if (xri && xri.trim()) return xri.trim();
  return "local";
}

export async function POST(req: NextRequest) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const ip = clientKey(req);
  const dispatchId = req.headers.get("x-dispatch-id");

  // 1) Rate limit (per client key) — cheapest gate, needs no body.
  const rate = checkRateLimit(ip, now);
  if (!rate.allowed) {
    await logDispatchAttempt({
      at, outcome: "rate-limited", ip, type: null, source: null, dispatchId,
      detail: `limit ${rate.limit}/min exceeded; retry in ${rate.retryAfterSec}s`,
    });
    return NextResponse.json(
      { ok: false, error: `rate limit exceeded (${rate.limit}/min)`, retryAfterSec: rate.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } }
    );
  }

  // 2) Parse body.
  let body: { type?: unknown; content?: unknown; source?: unknown; mockResponse?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    await logDispatchAttempt({
      at, outcome: "invalid", ip, type: null, source: null, dispatchId,
      detail: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
    return NextResponse.json(
      { ok: false, error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }

  // 3) Validate the public contract.
  const validationError = validateDispatchInput({
    type: body.type, content: body.content, source: body.source,
  });
  if (validationError) {
    await logDispatchAttempt({
      at, outcome: "invalid", ip,
      type: typeof body.type === "string" ? body.type : null,
      source: typeof body.source === "string" ? body.source : null,
      dispatchId, detail: validationError,
    });
    return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
  }

  const type = (body.type as string).trim().toLowerCase();
  const content = body.content as string;
  const source = typeof body.source === "string" ? body.source : "manual";

  // 4) Idempotency — a repeat X-Dispatch-Id within the TTL returns the
  //    cached body and does NOT re-dispatch.
  if (dispatchId) {
    const cached = getIdempotent(dispatchId, now);
    if (cached !== null) {
      await logDispatchAttempt({
        at, outcome: "duplicate", ip, type, source, dispatchId,
        detail: "idempotent replay — returned cached result",
      });
      return NextResponse.json({ ...(cached as object), idempotentReplay: true });
    }
  }

  // 5) Dispatch. dispatchEvent is total (never throws); belt + braces anyway.
  try {
    const result = await dispatchEvent(
      { type, content, source },
      { responseOverride: typeof body.mockResponse === "string" ? body.mockResponse : undefined }
    );
    const responseBody = { ok: true, result };
    if (dispatchId) storeIdempotent(dispatchId, responseBody, now);
    await logDispatchAttempt({
      at, outcome: "success", ip, type, source, dispatchId,
      detail: `${result.persona}/${result.status}`,
    });
    return NextResponse.json(responseBody);
  } catch (e) {
    await logDispatchAttempt({
      at, outcome: "error", ip, type, source, dispatchId,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { ok: false, error: `dispatch failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const status = await getDispatcherStatus();
    return NextResponse.json({ ...status, rateLimitPerMin: RATE_LIMIT_PER_MIN });
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
