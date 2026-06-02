// app/api/loops/rollback/route.ts
//
// Self-Evolving Loop Suite — backup browser + manual restore. GET lists every
// loop backup (restore/loops/<id>/) most-recent first. POST { backupId }
// restores the exact pre-write bytes from that backup. This is the operator's
// morning "undo any change a loop made" button. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { listLoopBackups, rollbackLoopBackup, getLoopBackup } from "@/lib/loops/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const backups = await listLoopBackups(100);
    return NextResponse.json({
      ok: true,
      backups: backups.map((b) => ({
        id: b.id,
        loopId: b.loopId,
        reason: b.reason,
        createdAt: b.createdAt,
        files: b.files.map((f) => ({ original: f.original, existed: f.existed, byteSize: f.byteSize })),
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, backups: [], error: String(e) }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { backupId?: string };
    const id = (body.backupId ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "backupId is required" }, { status: 200 });
    const manifest = await getLoopBackup(id);
    if (!manifest) return NextResponse.json({ ok: false, error: `unknown backup ${id}` }, { status: 200 });
    const r = await rollbackLoopBackup(id);
    return NextResponse.json({ ok: r.ok, restored: r.restored, reason: r.reason, backupId: id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
