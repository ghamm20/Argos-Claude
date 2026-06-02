// app/api/memory/facts/bulk/route.ts
//
// Bulk audit operations. Always 200.
//   { action: "setStatus", ids: [...], status, reason? }
//   { action: "approveSession", sessionId }
//   { action: "rejectOldUnreviewed", olderThanDays }

import { NextRequest, NextResponse } from "next/server";
import { bulkSetStatus, approveSession, rejectUnreviewedOlderThan } from "@/lib/memory-audit";
import type { FactStatus } from "@/lib/memory-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: ReadonlySet<string> = new Set(["unreviewed", "approved", "rejected", "flagged"]);

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      ids?: string[];
      status?: string;
      reason?: string;
      sessionId?: string;
      olderThanDays?: number;
    };
    switch (body.action) {
      case "setStatus": {
        if (!Array.isArray(body.ids) || body.ids.length === 0) return NextResponse.json({ ok: false, error: "ids required" }, { status: 200 });
        if (!VALID.has(body.status ?? "")) return NextResponse.json({ ok: false, error: "invalid status" }, { status: 200 });
        const r = await bulkSetStatus(body.ids, body.status as FactStatus, body.reason);
        return NextResponse.json(r);
      }
      case "approveSession": {
        if (!body.sessionId) return NextResponse.json({ ok: false, error: "sessionId required" }, { status: 200 });
        return NextResponse.json(await approveSession(body.sessionId));
      }
      case "rejectOldUnreviewed": {
        const days = Number(body.olderThanDays);
        if (!Number.isFinite(days) || days < 0) return NextResponse.json({ ok: false, error: "olderThanDays required" }, { status: 200 });
        return NextResponse.json(await rejectUnreviewedOlderThan(days));
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action: ${body.action}` }, { status: 200 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
