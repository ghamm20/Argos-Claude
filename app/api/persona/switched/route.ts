// app/api/persona/switched/route.ts
//
// v1.1 — best-effort audit event for persona switches. The store's
// switchPersona action POSTs here AFTER it sets the new persona +
// fires /api/model/warm. Failures are silent on the client side
// (audit is best-effort; never blocks the UI).
//
// AuditKind "persona.switched" was reserved in lib/audit.ts since
// Phase 4. This route is the writer that lets it actually land in
// the chain.

import { NextRequest, NextResponse } from "next/server";
import { appendAudit } from "@/lib/audit";
import { resolvePersona } from "@/lib/persona-server";
import { type PersonaId } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  personaId?: PersonaId;
  fromPersonaId?: PersonaId | null;
  model?: string;
  reason?: string;     // e.g. "user-click", "boot-hydration"
  sessionId?: string;
}

const VALID_PERSONAS = new Set<PersonaId>([
  "bartimaeus",
  "juniper",
  "sage",
  "bobby",
]);

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (e) {
    return NextResponse.json(
      { error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }
  if (!body.personaId || !VALID_PERSONAS.has(body.personaId)) {
    return NextResponse.json(
      { error: `personaId required and must be one of bartimaeus|juniper|sage|bobby` },
      { status: 400 }
    );
  }
  // v1.1: resolve persona with overrides applied so the audit
  // entry reflects effective wiring (not source defaults).
  const persona = await resolvePersona(body.personaId);

  try {
    const entry = await appendAudit(
      "persona.switched",
      {
        personaId: body.personaId,
        personaName: persona.name,
        fromPersonaId: body.fromPersonaId ?? null,
        model: body.model ?? persona.model,
        status: persona.status,
        reason: body.reason ?? "unspecified",
      },
      { sessionId: body.sessionId }
    );
    return NextResponse.json({
      ok: true,
      index: entry.index,
      hash: entry.hash,
    });
  } catch (e) {
    // Best-effort: if the chain can't be written we still return 200
    // with an `error` field so the client doesn't treat it as fatal.
    // The UI never blocks on this endpoint.
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 200 }
    );
  }
}
