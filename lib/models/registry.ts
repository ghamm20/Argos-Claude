// lib/models/registry.ts
//
// GPU-Agnostic Inference Layer / G2 (2026-06-09) — the TIERED MODEL REGISTRY,
// the agnostic routing core. Every model choice becomes a FUNCTION of the
// detected GPU tier, not a hardcode. One registry, three tiers, same code path:
// the 8GB (lean) path and the 24GB (ample) path are the SAME resolver reading a
// different detected capacity.
//
// LEAN PATH IS LOAD-BEARING: the lean column mirrors today's exact bindings, and
// for persona roles the lean value is taken LIVE from PERSONA_BY_ID so it can
// never drift. resolveModelForRole(role, leanProfile) therefore returns the
// EXACT current model — the lean path does not move.
//
// AVAILABILITY GUARD: the resolver checks the model is actually pulled (ollama
// /api/tags) before returning it; if a tier's model isn't present it falls DOWN
// one tier with a model.tier_fallback audit. Seating a 5090 unlocks ample
// ROUTING immediately, but until the ample models are pulled it transparently
// serves the lean models it has — never a broken state. Pulling later completes
// the upgrade with zero further code change.
//
// Pulls are a SEPARATE gated action — this registry only NAMES models.

import { appendAudit } from "../audit";
import { getOllamaBase } from "../ollama-config";
import { PERSONA_BY_ID, type PersonaId } from "../personas";
import type { GpuProfile, GpuTier } from "../gpu/detect";

export type ModelRole =
  | "tool-execution"
  | "judge"
  | "research"
  | `persona:${PersonaId}`;

export interface TieredModel {
  lean: string;
  mid: string;
  ample: string;
}

// Lean = exact current binding (load-bearing). mid = a conservative pulled
// upgrade where one exists. ample = the larger workhorse (operator pulls it
// when the bigger card lands; until then the availability guard falls back).
//
// Persona lean values are placeholders here — the resolver overrides them with
// the LIVE PERSONA_BY_ID binding so they cannot drift from the actual persona.
export const MODEL_REGISTRY: Record<ModelRole, TieredModel> = {
  "tool-execution": { lean: "hermes3:8b", mid: "qwen3:8b", ample: "qwen3-64k" },
  judge: { lean: "aratan/gemma-4-E4B-q8-it-heretic:latest", mid: "qwen3:8b", ample: "qwen3-64k" },
  research: { lean: "aratan/gemma-4-E4B-q8-it-heretic:latest", mid: "qwen3:8b", ample: "qwen3-64k" },
  // Persona conversational — IDENTITY/voice is unchanged across tiers; only the
  // underlying model scales. ample candidates per the documented intendedModel.
  "persona:bartimaeus": { lean: "aratan/gemma-4-E4B-q8-it-heretic:latest", mid: "aratan/gemma-4-E4B-q8-it-heretic:latest", ample: "huihui_ai/gpt-oss-abliterated:20b" },
  "persona:sage": { lean: "aratan/gemma-4-E4B-q8-it-heretic:latest", mid: "aratan/gemma-4-E4B-q8-it-heretic:latest", ample: "huihui_ai/gpt-oss-abliterated:20b" },
  "persona:juniper": { lean: "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b", mid: "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b", ample: "huihui_ai/gpt-oss-abliterated:20b" },
  "persona:bobby": { lean: "CyberCrew/notmythos-8b:latest", mid: "CyberCrew/notmythos-8b:latest", ample: "qwen3-64k" },
};

const TIER_ORDER: GpuTier[] = ["lean", "mid", "ample"];

/** The lean model for a role — for persona roles, the LIVE binding (no drift). */
function leanModelFor(role: ModelRole): string {
  if (role.startsWith("persona:")) {
    const id = role.slice("persona:".length) as PersonaId;
    return PERSONA_BY_ID[id]?.model || MODEL_REGISTRY[role].lean;
  }
  return MODEL_REGISTRY[role].lean;
}

/** The model NAME at a given tier for a role (no availability check). */
function modelAtTier(role: ModelRole, tier: GpuTier): string {
  if (tier === "lean") return leanModelFor(role);
  return MODEL_REGISTRY[role][tier];
}

// ---- installed-model cache (ollama /api/tags), short TTL ----
let installedCache: { at: number; set: Set<string> } | null = null;
const INSTALLED_TTL_MS = 30_000;

export async function listInstalledModels(force = false): Promise<Set<string>> {
  if (!force && installedCache && Date.now() - installedCache.at < INSTALLED_TTL_MS) {
    return installedCache.set;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${getOllamaBase()}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { models?: Array<{ name?: string }> };
      const set = new Set((j.models ?? []).map((m) => m.name ?? "").filter(Boolean));
      installedCache = { at: Date.now(), set };
      return set;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Ollama unreachable → empty set means "treat nothing as available", which
    // makes the resolver fall to the lean binding (the safe default).
    return installedCache?.set ?? new Set();
  }
}

export interface ResolveOpts {
  /** Operator per-role tier override (pin a role BELOW the detected tier). */
  tierOverride?: GpuTier;
  /** Pre-fetched installed set (avoids a tags call per resolve). */
  installed?: Set<string>;
  /** The EXACT lean-tier model to serve — preserves the operator's current
   *  choice byte-for-byte (persona: the requested body.model; tool-execution:
   *  settings.toolExecutionModel). On lean tier the resolver returns this
   *  unchanged; mid/ample upgrade from the registry and fall back to THIS. */
  leanOverride?: string;
}

export interface ResolvedModel {
  model: string;
  /** The tier actually SERVED (may be below requested if a model wasn't pulled). */
  servedTier: GpuTier;
  /** The tier REQUESTED by the detected GPU (capped by any override). */
  requestedTier: GpuTier;
  fellBack: boolean;
}

/**
 * Resolve the model for a role at the detected GPU tier, with availability
 * fallback DOWN tiers. The detected tier (capped by an optional operator
 * override) is the requested tier; if that model isn't pulled, step down a tier
 * until one is, ending at the lean binding (always present in a healthy
 * deployment). A fallback is audited as model.tier_fallback.
 */
export async function resolveModelForRole(
  role: ModelRole,
  profile: GpuProfile,
  opts: ResolveOpts = {}
): Promise<ResolvedModel> {
  const installed = opts.installed ?? (await listInstalledModels());
  // Requested tier = detected tier, but never ABOVE an operator override.
  let requestedTier = profile.tier;
  if (opts.tierOverride && TIER_ORDER.indexOf(opts.tierOverride) < TIER_ORDER.indexOf(requestedTier)) {
    requestedTier = opts.tierOverride;
  }
  const at = (tier: GpuTier) =>
    tier === "lean" && opts.leanOverride ? opts.leanOverride : modelAtTier(role, tier);

  // Walk from requested tier DOWN to lean, returning the first pulled model.
  const startIdx = TIER_ORDER.indexOf(requestedTier);
  for (let i = startIdx; i >= 0; i--) {
    const tier = TIER_ORDER[i];
    const model = at(tier);
    const available = installed.size === 0 ? tier === "lean" : installed.has(model);
    if (available || tier === "lean") {
      const fellBack = tier !== requestedTier;
      if (fellBack) {
        await appendAudit("model.tier_fallback", {
          role,
          requested: at(requestedTier),
          requestedTier,
          served: model,
          servedTier: tier,
          reason: `${at(requestedTier)} not installed at ${requestedTier} tier; served ${tier}`,
        }).catch(() => {});
      }
      return { model, servedTier: tier, requestedTier, fellBack };
    }
  }
  // Unreachable (lean always returns), but be safe.
  return { model: leanModelFor(role), servedTier: "lean", requestedTier, fellBack: requestedTier !== "lean" };
}
