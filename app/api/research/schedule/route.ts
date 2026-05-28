// app/api/research/schedule/route.ts
//
// Phase 11 — scheduler admin endpoint.
//
// GET    → status snapshot (running, startedAt, activeStreams, state)
// POST   → { action: "start" | "stop" | "tick", stream?: "weather"|"news"|"ai_updates"|"arxiv" }

import { NextRequest } from "next/server";
import {
  ensureSchedulerStarted,
  stopScheduler,
  getSchedulerStatus,
  tickStreamOnce,
} from "@/lib/research/scheduler";
import { readSettings, writeSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getSchedulerStatus();
    return Response.json(status);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

interface SchedulePostBody {
  action?: unknown;
  stream?: unknown;
}

export async function POST(req: NextRequest) {
  let body: SchedulePostBody;
  try {
    body = (await req.json()) as SchedulePostBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.action !== "string") {
    return Response.json(
      { error: "action required (start|stop|tick)" },
      { status: 400 }
    );
  }
  try {
    switch (body.action) {
      case "start": {
        // Persist enabled=true so subsequent boots come up with the
        // scheduler running. ensureSchedulerStarted() reads settings;
        // if we didn't flip enabled it'd return [] immediately.
        const cur = await readSettings();
        if (!cur.researchSchedule.enabled) {
          await writeSettings({
            researchSchedule: { ...cur.researchSchedule, enabled: true },
          });
        }
        const streams = await ensureSchedulerStarted();
        return Response.json({ ok: true, action: "start", streams });
      }
      case "stop": {
        await stopScheduler();
        // Persist enabled=false so the next boot doesn't auto-start.
        const cur = await readSettings();
        if (cur.researchSchedule.enabled) {
          await writeSettings({
            researchSchedule: { ...cur.researchSchedule, enabled: false },
          });
        }
        return Response.json({ ok: true, action: "stop" });
      }
      case "tick": {
        const stream = body.stream;
        if (
          typeof stream !== "string" ||
          !["weather", "news", "ai_updates", "arxiv"].includes(stream)
        ) {
          return Response.json(
            { error: "tick requires stream: weather|news|ai_updates|arxiv" },
            { status: 400 }
          );
        }
        await tickStreamOnce(stream as "weather" | "news" | "ai_updates" | "arxiv");
        return Response.json({ ok: true, action: "tick", stream });
      }
      default:
        return Response.json(
          { error: `unknown action: ${body.action}` },
          { status: 400 }
        );
    }
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
