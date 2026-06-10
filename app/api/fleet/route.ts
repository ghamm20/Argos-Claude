// app/api/fleet/route.ts
//
// Stage 10 (2026-06-09) — fleet command.
//   GET                      → configured endpoints + live reachability probe
//   POST { task, endpointId?, model? } → dispatch a drafting/coding task to a
//                              fleet endpoint; result returns through audit +
//                              the Judge pass. Unreachable → deferred (no halt).

import { NextRequest, NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { probeEndpoint, dispatchToFleet } from "@/lib/fleet/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await readSettings().catch(() => null);
  const endpoints = settings?.fleet?.endpoints ?? [];
  const probed = await Promise.all(endpoints.map(async (e) => ({ ...e, ...(await probeEndpoint(e.baseUrl)) })));
  return NextResponse.json({ endpoints: probed });
}

export async function POST(req: NextRequest) {
  let body: { task?: string; endpointId?: string; model?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (!task) return NextResponse.json({ error: "task is required" }, { status: 400 });
  return NextResponse.json(await dispatchToFleet({ task, endpointId: body.endpointId, model: body.model }));
}
