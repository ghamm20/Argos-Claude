// app/api/loops/feedback/route.ts
//
// Self-Evolving Loop Suite — operator feedback. POST { rating, note, loop? }
// appends to an append-only feedback log and, on negative feedback, runs the
// Reflexion loop to distill a lesson from it. GET returns recent feedback.
// Always 200.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { argosRoot } from "@/lib/vault/paths";
import { runLoopById } from "@/lib/loops/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function feedbackPath(): string {
  return path.join(argosRoot(), "state", "loops", "feedback.jsonl");
}

export async function GET() {
  try {
    const raw = await fsp.readFile(feedbackPath(), "utf8").catch(() => "");
    const items = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-50)
      .reverse();
    return NextResponse.json({ ok: true, feedback: items });
  } catch (e) {
    return NextResponse.json({ ok: false, feedback: [], error: String(e) }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      rating?: number;
      note?: string;
      loop?: string;
    };
    const rating = Number.isFinite(body.rating) ? Number(body.rating) : null;
    const note = (body.note ?? "").trim();
    if (rating === null && !note) {
      return NextResponse.json({ ok: false, error: "rating or note required" }, { status: 200 });
    }
    const entry = {
      at: new Date().toISOString(),
      rating,
      note: note.slice(0, 2000),
      loop: body.loop ?? null,
    };
    const p = feedbackPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.appendFile(p, JSON.stringify(entry) + "\n", "utf8");

    // Negative feedback (rating <= 2) → distill a lesson via Reflexion.
    let lesson: string | null = null;
    if (rating !== null && rating <= 2 && note) {
      const run = await runLoopById(
        "reflexion",
        { failure: `Operator gave negative feedback (rating ${rating}): ${note}` },
        { trigger: "command" }
      ).catch(() => null);
      const d = run?.result.data as { lesson?: string } | null;
      lesson = d?.lesson ?? null;
    }
    return NextResponse.json({ ok: true, recorded: entry, lesson });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
