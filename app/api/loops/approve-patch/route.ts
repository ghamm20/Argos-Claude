// app/api/loops/approve-patch/route.ts
//
// Self-Evolving Loop Suite — the GOVERNED apply path. This is the ONLY place a
// loop's high-risk proposal (a code/config patch) is ever written to disk, and
// it is fully gated:
//   1. The proposal must belong to a real "awaiting_approval" trace.
//   2. The rsi-gate must allow it (inside ARGOS_ROOT; governance code refused
//      unless ARGOS_RSI_ALLOW_GOVERNANCE is set).
//   3. A restore point is created BEFORE the write; if the snapshot fails, the
//      write is refused.
//   4. The operator must explicitly approve (this route is the click).
// After applying, the operator is told to run check:full and can roll back via
// the restore point. The action is recorded as an append-only "applied" trace.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { argosRoot } from "@/lib/vault/paths";
import { pendingApprovals, appendTrace, traceId } from "@/lib/loops/trace-store";
import { checkRsiProposal } from "@/lib/loops/rsi-gate";
import { createRestorePoint } from "@/lib/tools/restore";
import type { LoopTrace } from "@/lib/loops/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function decisionsLogAppend(entry: unknown): Promise<void> {
  const p = path.join(argosRoot(), "state", "loops", "patch-decisions.jsonl");
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
}

export async function GET() {
  try {
    const pending = await pendingApprovals(50);
    return NextResponse.json({
      ok: true,
      pending: pending.map((t) => ({
        traceId: traceId(t),
        at: t.at,
        loopId: t.loopId,
        loopNumber: t.loopNumber,
        summary: t.result.summary,
        proposals: t.result.proposals,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, pending: [], error: String(e) }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      traceId?: string;
      decision?: "approve" | "reject";
    };
    const id = (body.traceId ?? "").trim();
    const decision = body.decision === "approve" ? "approve" : "reject";
    if (!id) return NextResponse.json({ ok: false, error: "traceId is required" }, { status: 200 });

    const pending = await pendingApprovals(200);
    const trace = pending.find((t) => traceId(t) === id);
    if (!trace) {
      return NextResponse.json(
        { ok: false, error: `no pending patch for traceId ${id}` },
        { status: 200 }
      );
    }

    if (decision === "reject") {
      await decisionsLogAppend({ at: new Date().toISOString(), traceId: id, decision: "rejected" });
      return NextResponse.json({ ok: true, decision: "rejected", traceId: id });
    }

    // APPROVE — apply each patch proposal under a restore point.
    const applied: Array<{ target: string; restorePointId: string }> = [];
    const skipped: Array<{ target: string | null; reason: string }> = [];
    for (const p of trace.result.proposals) {
      if (p.kind !== "patch") {
        skipped.push({ target: p.target ?? null, reason: `${p.kind} proposal is advisory — not applied here` });
        continue;
      }
      if (!p.target || typeof p.payload !== "string") {
        skipped.push({ target: p.target ?? null, reason: "missing target or payload" });
        continue;
      }
      const check = checkRsiProposal(p);
      if (!check.allowed) {
        skipped.push({ target: p.target, reason: check.reason });
        continue;
      }
      const abs = path.isAbsolute(p.target) ? p.target : path.join(argosRoot(), p.target);
      const rp = await createRestorePoint(`loop:${trace.loopId}`, [abs]);
      if (!rp) {
        skipped.push({ target: p.target, reason: "restore snapshot failed — refused" });
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, p.payload, "utf8");
        applied.push({ target: p.target, restorePointId: rp });
      } catch (e) {
        skipped.push({ target: p.target, reason: `write failed: ${(e as Error).message}` });
      }
    }

    await decisionsLogAppend({
      at: new Date().toISOString(),
      traceId: id,
      decision: "approved",
      applied,
      skipped,
    });

    // Append-only "applied" trace so the history reflects the operator action.
    const appliedTrace: LoopTrace = {
      ...trace,
      at: new Date().toISOString(),
      outcome: applied.length > 0 ? "applied" : "rejected",
    };
    await appendTrace(appliedTrace);

    return NextResponse.json({
      ok: true,
      decision: "approved",
      traceId: id,
      applied,
      skipped,
      note:
        applied.length > 0
          ? "Applied. Run `npm run check:full` to verify; roll back via the restore point if anything breaks."
          : "Nothing was applied (all proposals were skipped — see `skipped`).",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
