// lib/models/concurrency.ts
//
// GPU-Agnostic Inference Layer / G3 (2026-06-09) — VRAM-aware concurrency.
// A bigger card doesn't just mean bigger models — it means MORE resident at
// once (no swap latency) and a lifted prompt-weight ceiling. Both are made
// tier-aware here.
//
// LEAN PATH IS LOAD-BEARING: on lean the policy is "serialize" — ONE model
// resident, swap as needed — which is EXACTLY today's behavior. This module
// only COMPUTES + AUDITS the policy; it does not change the chat route's
// keep_alive on lean. On ample it COMPUTES a resident set (tool + conversational
// + judge) sized to fit detected VRAM minus a reserve — computed, not executed,
// until the ample models are pulled. Headroom safety: a set that would exceed
// VRAM-minus-reserve drops to serialize with an audit warning. ARGOS never OOMs
// itself trying to use capacity it detected.

import { appendAudit } from "../audit";
import type { GpuProfile, GpuTier } from "../gpu/detect";
import { resolveModelForRole, listInstalledModels, type ModelRole } from "./registry";

/** Estimated resident VRAM (MB) per model, from `ollama list` sizes. Unknown
 *  models fall back to a conservative ~8B estimate. Quantized on-disk size is a
 *  good first-order proxy for resident footprint. */
const MODEL_VRAM_MB: Record<string, number> = {
  "nomic-embed-text:latest": 300,
  "CyberCrew/notmythos-8b:latest": 2000,
  "hermes3:8b": 4700,
  "qwen3:8b": 5200,
  "ssfdre38/gemma4-turbo:e4b": 6100,
  "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b": 6500,
  "aratan/gemma-4-E4B-q8-it-heretic:latest": 8100,
  "royhodge812/Orchestrator:lates": 9600,
  "huihui_ai/gpt-oss-abliterated:20b": 13800,
  "qwen3-64k": 6000, // estimate (unpulled)
};
const DEFAULT_MODEL_VRAM_MB = 8000;

export function estimateModelVramMb(model: string): number {
  return MODEL_VRAM_MB[model] ?? DEFAULT_MODEL_VRAM_MB;
}

/** Default VRAM held back so the system never schedules to the edge. */
export const DEFAULT_RESERVE_MB = 1024;

export type ConcurrencyMode = "serialize" | "resident-set";

export interface ResidentModel {
  role: ModelRole;
  model: string;
  vramMb: number;
}

export interface ConcurrencyPolicy {
  tier: GpuTier;
  mode: ConcurrencyMode;
  vramMb: number;
  reserveMb: number;
  /** The models the policy WOULD hold resident (computed; on lean this is the
   *  single active model — serialize). */
  resident: ResidentModel[];
  totalResidentMb: number;
  /** Does the resident set fit within vramMb - reserveMb? */
  fits: boolean;
  reason: string;
}

/** The roles a resident set tries to keep warm at ample tier (no-swap). */
const RESIDENT_ROLES: ModelRole[] = ["tool-execution", "persona:bartimaeus", "judge"];

/**
 * Compute the concurrency policy for a detected GPU profile. Pure-ish (one
 * cached ollama tags read via the resolver). Resolves each role to the model it
 * would ACTUALLY serve (post availability fallback), so the VRAM math reflects
 * reality, not aspirational ample names.
 */
export async function computeConcurrencyPolicy(
  profile: GpuProfile,
  opts: { reserveMb?: number; installed?: Set<string> } = {}
): Promise<ConcurrencyPolicy> {
  const reserveMb = opts.reserveMb ?? DEFAULT_RESERVE_MB;
  const installed = opts.installed ?? (await listInstalledModels());
  const budget = Math.max(0, profile.vramMb - reserveMb);

  // Lean (and the safe default): serialize — one model resident, swap as needed.
  // This is byte-for-byte today's behavior; we only record it.
  if (profile.tier === "lean") {
    const conv = await resolveModelForRole("persona:bartimaeus", profile, { installed });
    const vramMb = estimateModelVramMb(conv.model);
    return {
      tier: "lean", mode: "serialize", vramMb: profile.vramMb, reserveMb,
      resident: [{ role: "persona:bartimaeus", model: conv.model, vramMb }],
      totalResidentMb: vramMb, fits: vramMb <= budget,
      reason: "lean tier — serialize (one model resident, swap as needed) — unchanged",
    };
  }

  // Mid/ample: try to hold a resident set. Mid is conservative (top 2 roles);
  // ample tries all RESIDENT_ROLES. Then enforce the headroom reserve.
  const roles = profile.tier === "mid" ? RESIDENT_ROLES.slice(0, 2) : RESIDENT_ROLES;
  const resident: ResidentModel[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const r = await resolveModelForRole(role, profile, { installed });
    if (seen.has(r.model)) continue; // same model serving two roles = one load
    seen.add(r.model);
    resident.push({ role, model: r.model, vramMb: estimateModelVramMb(r.model) });
  }
  const totalResidentMb = resident.reduce((a, m) => a + m.vramMb, 0);

  // Headroom safety: if the set won't fit, DROP to serialize (never OOM).
  if (totalResidentMb > budget) {
    const conv = resident.find((r) => r.role.startsWith("persona:")) ?? resident[0];
    return {
      tier: profile.tier, mode: "serialize", vramMb: profile.vramMb, reserveMb,
      resident: conv ? [conv] : [],
      totalResidentMb: conv?.vramMb ?? 0, fits: true,
      reason: `resident set ${totalResidentMb}MB exceeds budget ${budget}MB (VRAM ${profile.vramMb} - reserve ${reserveMb}) — DROPPED to serialize to avoid OOM`,
    };
  }
  return {
    tier: profile.tier, mode: "resident-set", vramMb: profile.vramMb, reserveMb,
    resident, totalResidentMb, fits: true,
    reason: `resident set of ${resident.length} models (${totalResidentMb}MB) fits within budget ${budget}MB`,
  };
}

// ---- boot audit (once per process) ----
let policyAudited = false;
export async function auditConcurrencyPolicyOnce(profile: GpuProfile, reserveMb?: number): Promise<ConcurrencyPolicy> {
  const policy = await computeConcurrencyPolicy(profile, { reserveMb });
  if (!policyAudited) {
    policyAudited = true;
    await appendAudit("gpu.concurrency_policy", {
      tier: policy.tier, mode: policy.mode, vramMb: policy.vramMb, reserveMb: policy.reserveMb,
      resident: policy.resident.map((r) => ({ role: r.role, model: r.model, vramMb: r.vramMb })),
      totalResidentMb: policy.totalResidentMb, fits: policy.fits, reason: policy.reason,
    }).catch(() => {});
  }
  return policy;
}

/**
 * Tier-conditional prompt framing (G3 / Stage-1 finding) — a NO-OP STUB until
 * Stage 12's lean-tool-frame lands. The Stage-1 finding was that a heavy persona
 * prompt drowned hermes3 on LEAN. On ample, a larger tool model may tolerate the
 * full prompt — so the lean frame should apply on lean/mid and NOT on ample.
 * This switch encodes that DETECTED decision; nothing consumes it yet (Stage 12
 * will). Returns true when the lean tool-frame SHOULD apply.
 */
export function shouldUseLeanToolFrame(tier: GpuTier): boolean {
  return tier !== "ample";
}
