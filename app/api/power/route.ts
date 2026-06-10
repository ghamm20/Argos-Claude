// app/api/power/route.ts
//
// G4 (2026-06-09) — Power Mode status. available iff the detected GPU tier is
// ample. First hit boot-audits gpu.power_mode_available.
//
// Phase 7 (2026-06-10) — operator override. GET now resolves the EFFECTIVE
// status (real detection + operator override). POST { mode } sets the override
// (auto / force-off / attempt-on); attempt-on on insufficient hardware returns
// an HONEST VRAM failure (never fakes ample) and is audited. POST is gated by
// requireToolSession — changing the capability posture is an operator action.

import { NextRequest, NextResponse } from "next/server";
import { getGpuProfile } from "@/lib/gpu/detect";
import { auditPowerModeOnce } from "@/lib/power/mode";
import { effectivePowerStatus, setPowerOverride, readPowerOverride, type PowerOverrideMode } from "@/lib/power/override";
import { requireToolSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await getGpuProfile();
  // Boot-audit the raw availability once (unchanged G4 behavior), then return
  // the EFFECTIVE status (override applied) for the UI.
  await auditPowerModeOnce(profile);
  const effective = await effectivePowerStatus(profile);
  const override = await readPowerOverride();
  return NextResponse.json({ ...effective, overrideSetAt: override.at || null });
}

export async function POST(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: { mode?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const mode = body.mode;
  if (mode !== "auto" && mode !== "force-off" && mode !== "attempt-on") {
    return NextResponse.json({ error: 'mode must be "auto", "force-off", or "attempt-on"' }, { status: 400 });
  }
  const profile = await getGpuProfile();
  const effective = await setPowerOverride(mode as PowerOverrideMode, profile, typeof body.note === "string" ? body.note : "");
  // HTTP stays 200 — the attempt-on failure is a truthful RESULT, not a
  // transport error; the body carries attemptFailed + the explicit reason.
  return NextResponse.json(effective);
}
