// app/api/heartbeat/status/route.ts
//
// Phase 10 Heartbeat (2026-05-31) — status surface.
//
//   GET /api/heartbeat/status → {
//     enabled, running, intervalMinutes, startedAt, lastTickAt,
//     nextTickAt, last (HeartbeatResult|null), counts, stateFile,
//     checklistFile
//   }
//
// Always 200 (never errors) so the HUD can poll it safely.
//
// This module also BOOTS the heartbeat: the launcher curls this
// endpoint after Next is ready (mirroring the auto-ingest poke), which
// loads this module and calls ensureHeartbeatStarted(). Idempotent —
// no-op if already running or disabled.

import { NextResponse } from "next/server";
import {
  getHeartbeatStatus,
  ensureHeartbeatStarted,
} from "@/lib/heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module-init boot. Fire-and-forget; failures just mean the heartbeat
// starts lazily on the next status/trigger hit.
void ensureHeartbeatStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(`[heartbeat] boot from status route failed: ${(e as Error).message}`);
});

export async function GET() {
  try {
    // Opportunistically (re)start in case settings were toggled on.
    await ensureHeartbeatStarted().catch(() => {});
    const status = await getHeartbeatStatus();
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json({
      enabled: false,
      running: false,
      intervalMinutes: 30,
      startedAt: null,
      lastTickAt: null,
      nextTickAt: null,
      last: null,
      counts: { ticks: 0, ok: 0, actionable: 0, skipped: 0, errors: 0, alertsFired: 0 },
      stateFile: null,
      checklistFile: null,
      error: `status probe failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
