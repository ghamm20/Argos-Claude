// lib/power/mode.ts
//
// GPU-Agnostic Inference Layer / G4 (2026-06-09) — Power Mode. NOT a new engine:
// the NAME + visibility gate for the ample-tier capability set that G1–G3
// already route. It self-unblocks on detected ample tier — seating a bigger
// card, restarting, and pulling the ample models is the ENTIRE activation; no
// separate migration. On lean it is visibly UNAVAILABLE with the honest reason.
//
// LEAN PATH: this only ADDS a gate + a new surface (the council). The existing
// single-persona chat path is untouched.

import { appendAudit } from "../audit";
import type { GpuProfile } from "../gpu/detect";

export interface PowerModeStatus {
  available: boolean;
  tier: string;
  vramGb: number;
  reason: string;
  /** What Power Mode enables on ample (all already built by G1–G3 + the council). */
  enables: string[];
}

/** Power Mode is available exactly when the detected tier is ample. */
export function powerModeAvailable(profile: GpuProfile | null): boolean {
  return profile?.tier === "ample";
}

export function powerModeStatus(profile: GpuProfile | null): PowerModeStatus {
  const available = powerModeAvailable(profile);
  return {
    available,
    tier: profile?.tier ?? "lean",
    vramGb: profile?.vramGb ?? 0,
    reason: available
      ? `ample-tier GPU detected (${profile?.name}, ${profile?.vramGb}GB) — Power Mode active`
      : `requires ample-tier GPU — detected ${profile?.tier ?? "lean"}/${profile?.vramGb ?? 0}GB`,
    enables: [
      "ample per-persona models (tiered registry)",
      "resident multi-model set — no swap latency",
      "richer tool-frame (full persona prompt tolerated)",
      "qwen3-64k tool/reasoning workhorse (when pulled)",
      "parallel persona reasoning (council)",
    ],
  };
}

// Boot audit once per process (fires alongside GPU detection).
let audited = false;
export async function auditPowerModeOnce(profile: GpuProfile | null): Promise<PowerModeStatus> {
  const status = powerModeStatus(profile);
  if (!audited) {
    audited = true;
    await appendAudit("gpu.power_mode_available", {
      available: status.available, tier: status.tier, vramGb: status.vramGb,
      reason: status.reason, enables: status.enables,
    }).catch(() => {});
  }
  return status;
}
