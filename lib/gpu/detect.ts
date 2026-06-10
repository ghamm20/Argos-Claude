// lib/gpu/detect.ts
//
// GPU-Agnostic Inference Layer / G1 (2026-06-09) — classify the detected GPU's
// VRAM envelope into a capability TIER. The whole agnostic layer keys off this:
// the 8GB path and the 24GB path are the SAME code reading a different DETECTED
// capacity. Hardware changes underneath; ARGOS re-detects on next start and
// adapts — no code change, no settings edit.
//
// RECON-DRIVEN DESIGN (G1): lib/hardware.ts ALREADY detects GPU vendor / name /
// VRAM via nvidia-smi (cross-platform). To avoid two divergent nvidia-smi
// parsers, this module REUSES detectHardware() for the raw capacity and adds
// only what's missing: the TIER classification, per-process caching, a test-
// only forced-profile override, and the boot audit. No new detection, no deps.
//
// NEVER crashes on detection failure — degrades to the safe "lean" tier with a
// gpu.detect_fallback audit. The boot audit ALWAYS reflects the REAL detected
// GPU; a forced test profile (ARGOS_FORCE_GPU_PROFILE) is itself audited as
// forced, so an override is always visible — never silent hardware faking.

import { appendAudit } from "../audit";
import { detectHardware } from "../hardware";

export type GpuTier = "lean" | "mid" | "ample";

export interface GpuProfile {
  name: string;
  vramMb: number;
  vramGb: number;
  tier: GpuTier;
  /** True when this profile came from ARGOS_FORCE_GPU_PROFILE (test override),
   *  NOT from real hardware. The real-detection boot audit is never forced. */
  forced: boolean;
  /** Provenance: "hardware" (real nvidia-smi via detectHardware), "fallback"
   *  (no GPU / detection failed → lean), or "forced" (test override). */
  source: "hardware" | "fallback" | "forced";
  detectedAt: string;
}

/** Tier thresholds (directive): lean <10GB, mid 10–20GB, ample >20GB. */
export function tierForVramGb(vramGb: number): GpuTier {
  if (vramGb < 10) return "lean";
  if (vramGb <= 20) return "mid";
  return "ample";
}

/** The REAL detected GPU profile — sources capacity from detectHardware()
 *  (the single nvidia-smi detector), never the forced override. This is what
 *  the boot audit records. */
export async function detectRealGpu(force = false): Promise<GpuProfile> {
  const detectedAt = new Date().toISOString();
  let hw;
  try {
    hw = await detectHardware(force);
  } catch {
    return { name: "detection failed", vramMb: 0, vramGb: 0, tier: "lean", forced: false, source: "fallback", detectedAt };
  }
  const vramGb = hw.vramGB ?? 0;
  if (hw.gpuVendor === "none" || vramGb <= 0) {
    return { name: hw.gpuName ?? "no GPU", vramMb: 0, vramGb: 0, tier: "lean", forced: false, source: "fallback", detectedAt };
  }
  return {
    name: hw.gpuName ?? "unknown GPU",
    vramMb: vramGb * 1024,
    vramGb,
    tier: tierForVramGb(vramGb),
    forced: false,
    source: "hardware",
    detectedAt,
  };
}

/** Parse a forced test profile from "name,vramMb" (e.g. "NVIDIA RTX 5090,24576").
 *  Returns null if unset/malformed. */
function parseForcedProfile(): GpuProfile | null {
  const raw = process.env.ARGOS_FORCE_GPU_PROFILE?.trim();
  if (!raw) return null;
  const [name, vram] = raw.split(",").map((s) => s.trim());
  const vramMb = parseInt(vram, 10);
  if (!name || !Number.isFinite(vramMb) || vramMb <= 0) return null;
  const vramGb = Math.round(vramMb / 1024);
  return { name, vramMb, vramGb, tier: tierForVramGb(vramGb), forced: true, source: "forced", detectedAt: new Date().toISOString() };
}

// Per-process cache: detect once at boot. forceRedetect() clears it.
let cached: GpuProfile | null = null;
let auditWritten = false;

/**
 * The EFFECTIVE GPU profile (cached per process). On first call it detects the
 * REAL GPU and writes the boot audit (gpu.profile_detected, or
 * gpu.detect_fallback when no GPU). If ARGOS_FORCE_GPU_PROFILE is set, the
 * EFFECTIVE profile is the forced override (for testing ample paths) and a
 * gpu.profile_forced note is also written — so the record reflects the TRUE
 * hardware AND the active override.
 */
export async function getGpuProfile(): Promise<GpuProfile> {
  if (cached) return cached;
  const real = await detectRealGpu();
  if (!auditWritten) {
    auditWritten = true;
    await appendAudit(real.source === "fallback" ? "gpu.detect_fallback" : "gpu.profile_detected", {
      name: real.name, vramMb: real.vramMb, vramGb: real.vramGb, tier: real.tier, source: real.source,
    }).catch(() => {});
  }
  const forced = parseForcedProfile();
  if (forced) {
    await appendAudit("gpu.profile_forced", {
      name: forced.name, vramMb: forced.vramMb, tier: forced.tier,
      note: "TEST override active (ARGOS_FORCE_GPU_PROFILE) — not real hardware",
    }).catch(() => {});
    cached = forced;
    return forced;
  }
  cached = real;
  return real;
}

/** Force a fresh detection (clears the per-process cache + re-detects hardware). */
export async function forceRedetect(): Promise<GpuProfile> {
  cached = null;
  auditWritten = false;
  await detectRealGpu(true); // bust detectHardware's own cache too
  return getGpuProfile();
}
