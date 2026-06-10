// app/api/gpu/route.ts
//
// G1 (2026-06-09) — the detected GPU capability profile (name, VRAM, tier).
// First hit triggers boot detection + the gpu.profile_detected audit (the
// provable record of what ARGOS thinks it's running on). Read-only; drives the
// HUD/dashboard GPU tile. POST { redetect: true } forces a fresh detection.

import { NextRequest, NextResponse } from "next/server";
import { getGpuProfile, forceRedetect } from "@/lib/gpu/detect";
import { auditConcurrencyPolicyOnce } from "@/lib/models/concurrency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await getGpuProfile();
  // G3: compute + boot-audit the VRAM-aware concurrency policy alongside the
  // profile (gpu.concurrency_policy fires once per process).
  const concurrency = await auditConcurrencyPolicyOnce(profile).catch(() => null);
  return NextResponse.json({ ...profile, concurrency });
}

export async function POST(req: NextRequest) {
  let body: { redetect?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty ok */ }
  const profile = body.redetect ? await forceRedetect() : await getGpuProfile();
  const concurrency = await auditConcurrencyPolicyOnce(profile).catch(() => null);
  return NextResponse.json({ ...profile, concurrency });
}
