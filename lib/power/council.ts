// lib/power/council.ts
//
// G4 (2026-06-09) — PARALLEL PERSONA REASONING ("council"). A Power-Mode-only
// surface: on ample tier (multiple models resident, no swap), dispatch ONE query
// to N personas CONCURRENTLY — each on its own resident model — and collect
// per-persona results. HARD-gated to ample: on lean/mid it refuses, because
// running N heavy models on 8GB would thrash. This is an ADDITIVE surface; the
// single-persona chat path is untouched.
//
// Deterministic-testable: the per-persona generation is injectable (a stub for
// proofs / ARGOS_COUNCIL_STUB), so forced-ample testing proves the CONCURRENCY
// MECHANISM without thrashing real 8GB hardware or faking the GPU.

import { appendAudit } from "../audit";
import { getOllamaBase } from "../ollama-config";
import { PERSONA_BY_ID, type PersonaId } from "../personas";
import type { GpuProfile } from "../gpu/detect";
import { powerModeAvailable } from "./mode";
import { resolveModelForRole, listInstalledModels, type ModelRole } from "../models/registry";

export interface CouncilMemberResult {
  persona: PersonaId;
  model: string;
  ok: boolean;
  content: string;
  latencyMs: number;
  error?: string;
}

export interface CouncilResult {
  available: boolean;
  reason: string;
  query: string;
  members: CouncilMemberResult[];
  /** Wall-clock for the whole concurrent dispatch (≈ slowest member, not sum). */
  durationMs: number;
}

export type GenerateFn = (model: string, systemPrompt: string, query: string) => Promise<string>;

/** Real per-persona generation — non-streamed Ollama call. */
const realGenerate: GenerateFn = async (model, systemPrompt, query) => {
  const res = await fetch(`${getOllamaBase()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: query }],
      stream: false,
      think: false,
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = (await res.json()) as { message?: { content?: string } };
  return (j.message?.content ?? "").trim();
};

/** Stub generation for deterministic proofs (no real inference). */
const stubGenerate: GenerateFn = async (model, _sys, query) =>
  `[stub:${model}] reasoned on: ${query.slice(0, 40)}`;

/**
 * Run a parallel persona council. Refuses unless Power Mode (ample tier) is
 * available. Each member runs CONCURRENTLY on its tier-resolved model.
 */
export async function runCouncil(
  query: string,
  personaIds: PersonaId[],
  opts: { profile: GpuProfile | null; installed?: Set<string>; generate?: GenerateFn; nowMs?: number } = { profile: null }
): Promise<CouncilResult> {
  const start = opts.nowMs ?? Date.now();
  if (!powerModeAvailable(opts.profile)) {
    return {
      available: false,
      reason: `parallel persona reasoning requires Power Mode (ample-tier GPU) — detected ${opts.profile?.tier ?? "lean"}`,
      query, members: [], durationMs: 0,
    };
  }
  const generate =
    opts.generate ?? (process.env.ARGOS_COUNCIL_STUB ? stubGenerate : realGenerate);
  const installed = opts.installed ?? (await listInstalledModels());
  const ids = personaIds.filter((id) => PERSONA_BY_ID[id]);

  // CONCURRENT dispatch — each member on its own resident model. Wall-clock is
  // the slowest member, not the sum (the whole point of the resident set).
  const members = await Promise.all(
    ids.map(async (persona): Promise<CouncilMemberResult> => {
      const r = await resolveModelForRole(`persona:${persona}` as ModelRole, opts.profile!, { installed });
      const mStart = Date.now();
      try {
        const content = await generate(r.model, PERSONA_BY_ID[persona].systemPrompt, query);
        return { persona, model: r.model, ok: true, content, latencyMs: Date.now() - mStart };
      } catch (e) {
        return { persona, model: r.model, ok: false, content: "", latencyMs: Date.now() - mStart, error: e instanceof Error ? e.message : String(e) };
      }
    })
  );

  const durationMs = Date.now() - start;
  await appendAudit("power_mode.council_run", {
    query: query.slice(0, 200),
    personas: ids,
    models: members.map((m) => m.model),
    ok: members.filter((m) => m.ok).length,
    total: members.length,
    durationMs,
  }).catch(() => {});

  return { available: true, reason: "Power Mode active — council dispatched concurrently", query, members, durationMs };
}
