// app/api/power/route.ts
//
// G4 (2026-06-09) — Power Mode status. available iff the detected GPU tier is
// ample. Read-only; drives the HUD/dashboard Power Mode tile. First hit also
// boot-audits gpu.power_mode_available.

import { NextResponse } from "next/server";
import { getGpuProfile } from "@/lib/gpu/detect";
import { auditPowerModeOnce } from "@/lib/power/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await getGpuProfile();
  return NextResponse.json(await auditPowerModeOnce(profile));
}
