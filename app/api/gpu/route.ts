// app/api/gpu/route.ts
//
// G1 (2026-06-09) — the detected GPU capability profile (name, VRAM, tier).
// First hit triggers boot detection + the gpu.profile_detected audit (the
// provable record of what ARGOS thinks it's running on). Read-only; drives the
// HUD/dashboard GPU tile. POST { redetect: true } forces a fresh detection.

import { NextRequest, NextResponse } from "next/server";
import { getGpuProfile, forceRedetect } from "@/lib/gpu/detect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getGpuProfile());
}

export async function POST(req: NextRequest) {
  let body: { redetect?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty ok */ }
  return NextResponse.json(body.redetect ? await forceRedetect() : await getGpuProfile());
}
