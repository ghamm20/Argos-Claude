// app/api/models/resolve/route.ts
//
// G2 (2026-06-09) — resolve the model a ROLE gets at the detected GPU tier
// (with availability fallback). Read-only diagnostic surface for the dashboard
// + proofs: GET ?role=tool-execution|judge|research|persona:<id>  (omit role →
// resolve ALL roles). Honors the forced GPU profile + per-role tier overrides.

import { NextRequest, NextResponse } from "next/server";
import { getGpuProfile } from "@/lib/gpu/detect";
import { resolveModelForRole, listInstalledModels, MODEL_REGISTRY, type ModelRole } from "@/lib/models/registry";
import { readSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const profile = await getGpuProfile();
  const settings = await readSettings().catch(() => null);
  const installed = await listInstalledModels();
  const roleParam = req.nextUrl.searchParams.get("role");
  const roles = (roleParam ? [roleParam] : Object.keys(MODEL_REGISTRY)) as ModelRole[];

  const resolved: Record<string, unknown> = {};
  for (const role of roles) {
    resolved[role] = await resolveModelForRole(role, profile, {
      installed,
      tierOverride: settings?.perRoleTierOverride?.[role],
    });
  }
  return NextResponse.json({ profile, resolved });
}
