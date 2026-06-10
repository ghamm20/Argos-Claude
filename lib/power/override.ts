// lib/power/override.ts
//
// Phase 7 (2026-06-10) — the OPERATOR Power-Mode override. Distinct from the
// test-only ARGOS_FORCE_GPU_PROFILE env (which fakes an ample GPU to exercise
// the ample CODE path in unit/mock tests). This is the GUI switch the spec
// requires: a durable, operator-set three-way control over Power Mode.
//
//   auto        — follow real detection (Power Mode available iff tier==ample)
//   force-off   — operator disables Power Mode even on ample hardware
//   attempt-on  — operator asks to turn Power Mode ON. If the REAL detected
//                 tier is ample → it engages. If NOT → it FAILS CLEANLY with
//                 an explicit VRAM error and is audited. It NEVER fakes ample,
//                 never crashes, never silently falls back to a working state.
//
// The honest-failure path (attempt-on below ample) is the load-bearing
// behavior: a 3060 Ti operator who forces Power Mode on gets a truthful "you
// don't have the VRAM" — not a fake success and not a crash.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";
import type { GpuProfile } from "../gpu/detect";
import { powerModeStatus, type PowerModeStatus } from "./mode";

export type PowerOverrideMode = "auto" | "force-off" | "attempt-on";

export interface PowerOverride {
  mode: PowerOverrideMode;
  at: string;
  /** Operator note or the system reason (e.g. an attempt-on failure). */
  reason: string;
}

const DEFAULT_OVERRIDE: PowerOverride = { mode: "auto", at: "", reason: "default — follow detection" };

export function powerOverridePath(): string {
  return path.join(argosRoot(), "state", "gpu", "power-override.json");
}

export async function readPowerOverride(): Promise<PowerOverride> {
  try {
    const o = JSON.parse(await fsp.readFile(powerOverridePath(), "utf8")) as Partial<PowerOverride>;
    const mode: PowerOverrideMode =
      o.mode === "force-off" || o.mode === "attempt-on" ? o.mode : "auto";
    return { mode, at: o.at ?? "", reason: o.reason ?? "" };
  } catch {
    return { ...DEFAULT_OVERRIDE };
  }
}

async function writePowerOverride(o: PowerOverride): Promise<void> {
  await fsp.mkdir(path.dirname(powerOverridePath()), { recursive: true });
  await fsp.writeFile(powerOverridePath(), JSON.stringify(o, null, 2), "utf8");
}

export interface EffectivePowerStatus extends PowerModeStatus {
  /** The operator override in effect. */
  override: PowerOverrideMode;
  /** True when attempt-on was requested but the real hardware can't support it
   *  — the response is an HONEST failure, not a working Power Mode. */
  attemptFailed: boolean;
  /** Explicit VRAM error on a failed attempt-on (null otherwise). */
  error: string | null;
}

/** Resolve the EFFECTIVE Power-Mode status from the REAL detected profile and
 *  the operator override. Pure (no I/O, no audit) so it is unit-testable. */
export function resolveEffectivePower(
  realProfile: GpuProfile | null,
  override: PowerOverrideMode
): EffectivePowerStatus {
  const base = powerModeStatus(realProfile); // truth from real detection
  if (override === "force-off") {
    return {
      ...base,
      available: false,
      reason: `operator override: Power Mode force-OFF (detected ${base.tier}/${base.vramGb}GB)`,
      override,
      attemptFailed: false,
      error: null,
    };
  }
  if (override === "attempt-on") {
    if (base.available) {
      return { ...base, reason: `operator attempt-on: ${base.reason}`, override, attemptFailed: false, error: null };
    }
    // HONEST FAILURE — the operator forced it on insufficient hardware.
    const error = `Power Mode attempt-on FAILED: detected ${base.tier}-tier GPU with ${base.vramGb}GB VRAM; Power Mode requires an ample-tier GPU (≥24GB). No features enabled — this is an honest failure, not a fallback.`;
    return { ...base, available: false, reason: error, override, attemptFailed: true, error };
  }
  // auto
  return { ...base, override, attemptFailed: false, error: null };
}

/** Read the override + resolve effective status against a real profile. */
export async function effectivePowerStatus(realProfile: GpuProfile | null): Promise<EffectivePowerStatus> {
  const ov = await readPowerOverride();
  return resolveEffectivePower(realProfile, ov.mode);
}

/** Set the operator override. attempt-on against insufficient hardware persists
 *  as attempt-on (operator intent is recorded) but the returned status is an
 *  honest failure, and BOTH the set and the failure are audited. */
export async function setPowerOverride(
  mode: PowerOverrideMode,
  realProfile: GpuProfile | null,
  note = ""
): Promise<EffectivePowerStatus> {
  const eff = resolveEffectivePower(realProfile, mode);
  const reason = eff.error ?? note ?? "";
  await writePowerOverride({ mode, at: new Date().toISOString(), reason });
  await appendAudit("gpu.power_override", {
    mode,
    detectedTier: realProfile?.tier ?? "lean",
    detectedVramGb: realProfile?.vramGb ?? 0,
    effectiveAvailable: eff.available,
    attemptFailed: eff.attemptFailed,
    note: note || null,
  }).catch(() => {});
  if (eff.attemptFailed) {
    await appendAudit("gpu.power_attempt_failed", {
      detectedTier: realProfile?.tier ?? "lean",
      detectedVramGb: realProfile?.vramGb ?? 0,
      error: eff.error,
    }).catch(() => {});
  }
  return eff;
}
