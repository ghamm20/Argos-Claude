// app/api/orchestrator/route.ts
//
// Minimal API surface for the multi-agent runtime:
//   POST /api/orchestrator        → enqueue work
//   GET  /api/orchestrator/state  → agent status HUD
//   POST /api/orchestrator/resource → acquire / release locks (admin)
//
// Auth: every endpoint requires a valid bearer token via
// lib/auth.ts.requireValidSession. This keeps the multi-agent layer
// out of guest-mode hands and aligns with existing auth gating.
//
// Integration point: chat/route.ts and tools/execute can enqueue work
// with the orchestrator instead of (or in addition to) running inline.

import { NextRequest, NextResponse } from "next/server";
import { getOrchestrator } from "@/lib/agents/orchestrator";
import { requireValidSession } from "@/lib/auth";
import type {
  WorkItem,
  AgentId,
  ResourceKey,
} from "@/lib/agents/schemas";

// ---------------------------------------------------------------------------
// Shared boot / guards
// ---------------------------------------------------------------------------

// Local helper — NOT exported: Next.js App Router route files may only export
// route handlers (GET/POST/…) + config. Exporting this broke `next build`
// (the route-type validator that tsc doesn't run). Fix: Phase 7-C, 2026-06-04.
async function ensureEnabled(req: NextRequest): Promise<NextResponse | null> {
  const auth = await requireValidSession(req);
  // null = authorized → handler proceeds. Otherwise convert the AuthFailure
  // into a real Response so handlers can `return guard` (route handlers must
  // return void|Response, not a raw object). Fix: Phase 7-C, 2026-06-04.
  return auth ? NextResponse.json({ error: auth.error }, { status: auth.status }) : null;
}

// ---------------------------------------------------------------------------
// POST /api/orchestrator   → enqueue a work item
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // Resource-lock control sub-path: POST /api/orchestrator/resource → delegate
  // to handleResource (completes commit 4d38492 — the handler was written but
  // never wired, which left it dead-code and broke `next build`). It runs its
  // own auth guard. Fix: Phase 7-C, 2026-06-04.
  if (new URL(req.url).pathname.replace(/\/+$/, "").endsWith("/resource")) {
    return handleResource(req);
  }

  const guard = await ensureEnabled(req);
  if (guard) return guard;

  let body: Partial<WorkItem> | null = null;
  try {
    body = (await req.json()) as Partial<WorkItem>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body?.kind || !body.payload || typeof body.payload !== "object") {
    return NextResponse.json(
      { error: "missing_required_fields", required: ["kind", "payload"] },
      { status: 400 }
    );
  }

  const orch = getOrchestrator();
  const item: WorkItem = {
    id: body.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    kind: body.kind,
    priority: body.priority ?? "normal",
    label: body.label ?? "",
    requestContext: body.requestContext ?? {},
    personaId: body.personaId,
    toolCall: body.toolCall,
    research: body.research,
    payload: body.payload,
    suggestedAgent: body.suggestedAgent,
    maxRetries: body.maxRetries ?? 2,
    deadlineAt: body.deadlineAt,
  };

  const enqueued = orch.enqueue(item);

  return NextResponse.json(
    {
      ok: true,
      workItem: enqueued,
    },
    { status: 202 }
  );
}

// ---------------------------------------------------------------------------
// GET /api/orchestrator/state
// ---------------------------------------------------------------------------
// Also handles the canonical /api/orchestrator so the actual router
// file is a single entry. The surrounding project structure may expose
// children; this file owns the parent.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const guard = await ensureEnabled(req);
  if (guard) return guard;

  const orch = getOrchestrator();
  const url = new URL(req.url);
  const resource = url.pathname.replace(/\/api\/orchestrator\/?/, "");
  if (resource === "state") {
    return NextResponse.json({
      ok: true,
      state: orch.allStates(),
    });
  }

  return NextResponse.json(
    { error: "not_found", hint: "try POST, or GET /state" },
    { status: 404 }
  );
}

// ---------------------------------------------------------------------------
// Resource lock control (POST /api/orchestrator/resource)
// ---------------------------------------------------------------------------

// Local helper — NOT exported (Next route-export contract; see ensureEnabled).
async function handleResource(req: NextRequest) {
  const guard = await ensureEnabled(req);
  if (guard) return guard;

  const orch = getOrchestrator();
  let body: { action: "acquire" | "release"; resource: ResourceKey; agentId?: AgentId } | null = null;
  try {
    body = (await req.json()) as { action: "acquire" | "release"; resource: ResourceKey; agentId?: AgentId };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body?.action || !body.resource) {
    return NextResponse.json(
      { error: "missing", required: ["action", "resource"] },
      { status: 400 }
    );
  }

  if (body.action === "acquire") {
    if (!body.agentId) {
      return NextResponse.json({ error: "agentId_required_for_acquire" }, { status: 400 });
    }
    const result = orch.acquireResource(body.resource, body.agentId);
    if (result.granted) {
      return NextResponse.json({ ok: true, lock: result.lock });
    }
    return NextResponse.json(
      { ok: false, blockedBy: result.blockedBy, retryAfterMs: result.retryAfterMs },
      { status: 409 }
    );
  }

  if (body.action === "release") {
    const agentId = body.agentId ?? "supervisor";
    orch.releaseResource(body.resource, agentId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
