// app/api/tools/restore/route.ts
//
// Stage 1 agentic (2026-06-09) — operator-triggered rollback of a restore
// point created before a destructive file_ops (delete). The snapshot machinery
// (createRestorePoint) and the rollback (restoreFromPoint) already existed but
// had no caller; this wires the rollback and writes a tool-audit entry so the
// restore is recorded next to the delete it undoes.
//
//   GET                      → { points: string[] }   (newest first)
//   POST { restoreId }       → { ok, restored, reason }
//
// Restore only ever writes back inside ARGOS_ROOT (the manifest's snapshotted
// originals are all bounded paths). No approval gate: restoring is the SAFE
// direction (it returns state to a known-good snapshot the operator already
// approved creating).

import { NextRequest, NextResponse } from "next/server";
import { restoreFromPoint, listRestorePoints } from "@/lib/tools/restore";
import { appendToolAudit } from "@/lib/tools/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const points = await listRestorePoints();
  return NextResponse.json({ points });
}

export async function POST(req: NextRequest) {
  let body: { restoreId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const restoreId = typeof body.restoreId === "string" ? body.restoreId.trim() : "";
  if (!restoreId) {
    return NextResponse.json({ error: "restoreId is required" }, { status: 400 });
  }

  const start = Date.now();
  const out = await restoreFromPoint(restoreId);
  // Audit the restore next to the delete it undoes (the directive's "both
  // audit entries"). Best-effort; never blocks the response.
  await appendToolAudit({
    at: new Date().toISOString(),
    toolId: "file_ops",
    approved: true,
    ok: out.ok,
    summary: out.ok
      ? `restored ${out.restored} file(s) from restore point ${restoreId}`
      : `restore failed for point ${restoreId}: ${out.reason}`,
    error: out.ok ? null : out.reason,
    restorePointId: restoreId,
    sessionId: null,
    persona: null,
    durationMs: Date.now() - start,
  });

  return NextResponse.json(out, { status: out.ok ? 200 : 404 });
}
