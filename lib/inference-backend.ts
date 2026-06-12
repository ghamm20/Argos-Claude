// lib/inference-backend.ts
//
// v2.4.2 Phase A — inference backend switch (local Ollama OR Nous free tier).
//
// Two INDEPENDENT axes, kept deliberately separate (do not tangle):
//   1. Backend     — WHERE a persona's chat call runs: "local" (Ollama) or
//                    "nous" (Nous Research API). Resolved per persona with a
//                    global default. This phase routes the Nous path to ONE
//                    model only: nvidia/nemotron-3-ultra:free (free tier,
//                    $0/$0 — confirmed live in Step 1 recon).
//   2. Rebound     — a LOCAL model swap behind a separate feature flag
//                    (useReboundModels): Juniper + Bobby move to the proven
//                    local gemma-4 (already resident for Bart/Sage — no new
//                    VRAM). This is NOT Nemotron and NOT a backend change.
//
// HONESTY DOCTRINE (Phase A; tightened 2026-06-12, owner directive — "the
// switch just works", no silent impersonation):
//   - The ONLY cloud model wired is NOUS_MODEL below. Never the paid 550b
//     sibling (nvidia/nemotron-3-ultra-550b-a55b) or any ~anthropic / ~google
//     / ~openai proxy (those are billed per token).
//   - callNous returns the EXACT model the API echoed back; the caller logs
//     that literal string, never a generic "nous" label.
//   - Any failure (missing key, non-2xx, timeout, empty/reasoning-only body)
//     THROWS. The caller still answers locally so the operator is never left
//     without a reply, but the failure is SURFACED — fallback reason in the
//     backend frame, HUD badge ("cloud failed: <reason> — answered locally"),
//     and the chat.inference audit entry. We never fabricate a response or a
//     backend label, and we never pretend a local answer came from the cloud.
//   - No new npm deps: native fetch only.
//
// EMPTY-CONTENT ROOT CAUSE (2026-06-12 diagnosis, _diag_nous-shape*.json):
//   nemotron-3-ultra is a REASONING model — every response carries a separate
//   message.reasoning field (13/13 live trials, 92–312 chars) alongside
//   message.content, and max_tokens budgets BOTH. ARGOS forwarded Bart's
//   brief-register cap (250) straight through, so a long-reasoning turn could
//   exhaust the budget before any visible content → HTTP 200 with empty
//   content ("nous returned empty content", 4 failures on 2026-06-11). The
//   endpoint also throws intermittent 500s (observed live, 1/13) and slow
//   turns near the old 30s abort (observed 19.2s on trivial prompts; the
//   2026-06-11 abort ×1). Fixes:
//     1. max_tokens FLOOR (NOUS_MIN_MAX_TOKENS) so reasoning can never starve
//        the visible answer; the local num_predict cap is a local concept.
//     2. Reasoning-aware parse: content empty + reasoning present is named
//        precisely ("reasoning-only response"), never the generic "empty".
//        Reasoning text is NEVER presented as the answer (it is not the
//        assistant's voice).
//     3. One bounded retry on transient failures (5xx / empty / reasoning-
//        only) within a total budget that leaves the local fallback room
//        under the orchestrator's 60s first-token wall.

import type {
  PersistedSettings,
  PersonaBackendChoice,
  CloudDataPolicy,
} from "./settings";

/** Nous OpenAI-compatible chat-completions endpoint. */
export const NOUS_CHAT_URL =
  "https://inference-api.nousresearch.com/v1/chat/completions";

/** The SOLE cloud model this phase routes to. Free tier ($0/$0), confirmed
 *  live. Never substitute the paid 550b sibling or a proxy model. */
export const NOUS_MODEL = "nvidia/nemotron-3-ultra:free";

/** Local model Juniper + Bobby rebind to when useReboundModels is true.
 *  Matches MODEL_BART / MODEL_SAGE in lib/personas.ts (already resident). */
export const REBOUND_MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

/** Personas the rebind flag moves to REBOUND_MODEL. Bart/Sage already run it. */
const REBOUND_PERSONAS = new Set<string>(["juniper", "bobby"]);

/** Per-attempt abort budget for one Nous request (directive: 30s). */
const NOUS_TIMEOUT_MS = 30_000;

/** Total Nous budget across attempts. Must stay comfortably under the
 *  orchestrator's 60s first-token wall so a final local fallback still has
 *  time to produce its first token. */
const NOUS_TOTAL_BUDGET_MS = 45_000;

/** Floor for max_tokens on the Nous path. Nemotron's reasoning tokens come
 *  out of the same budget as the visible answer; forwarding a small local
 *  num_predict cap (Bart brief = 250) verbatim starved content entirely on
 *  long-reasoning turns (the 2026-06-11 empty-content failures). */
export const NOUS_MIN_MAX_TOKENS = 1024;

export type InferenceBackend = "local" | "nous";

/**
 * Resolve the effective LOCAL model id for a persona, applying the
 * useReboundModels swap. Pure: no I/O. When the flag is off (default) or the
 * persona isn't in the rebound set, the requested model passes through
 * unchanged — so the default deployment behaves identically.
 */
export function resolveLocalModel(
  personaId: string,
  requestedModel: string,
  useReboundModels: boolean
): string {
  return useReboundModels && REBOUND_PERSONAS.has(personaId)
    ? REBOUND_MODEL
    : requestedModel;
}

/**
 * Resolve which backend a persona's call should target.
 *   perPersonaBackend[persona] when set to "local"|"nous" wins;
 *   "default" (or unset) defers to the global inferenceBackend;
 *   null settings → "local" (safe default).
 */
export function resolveBackend(
  personaId: string,
  settings: PersistedSettings | null
): InferenceBackend {
  if (!settings) return "local";
  const per = settings.perPersonaBackend?.[
    personaId as keyof PersistedSettings["perPersonaBackend"]
  ] as PersonaBackendChoice | undefined;
  if (per === "local" || per === "nous") return per;
  return settings.inferenceBackend === "nous" ? "nous" : "local";
}

/**
 * Resolve a persona's cloud data policy. Gate 2 (2026-06-09).
 *   "full"     ONLY when explicitly opted in for this persona.
 *   "redacted" otherwise — the safe default (absent persona, null settings, or
 *              any non-"full" value). On a Nous turn, "redacted" strips vault
 *              chunks, memory facts, and prior tool results before the call.
 */
export function resolveCloudDataPolicy(
  personaId: string,
  settings: PersistedSettings | null
): CloudDataPolicy {
  const per = settings?.cloudDataPolicy?.[
    personaId as keyof PersistedSettings["cloudDataPolicy"]
  ];
  return per === "full" ? "full" : "redacted";
}

export interface NousResult {
  /** Assistant text. Guaranteed non-empty (callNous throws on empty). */
  content: string;
  /** The EXACT model id the API echoed back (logged verbatim). */
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** How many attempts the call took (1 = first try; 2 = one retry). */
  attempts: number;
}

/** A failure worth ONE retry: transient server error or a reasoning-only/
 *  empty body (provider-side nondeterminism observed live 2026-06-12). A
 *  4xx (bad key, bad request) or an abort (budget spent) is NOT retried. */
function isRetryableNousError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /^nous 5\d\d:/.test(msg) || /reasoning-only|empty content/.test(msg);
}

async function callNousOnce(
  opts: {
    apiKey: string;
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number | null;
  },
  timeoutMs: number
): Promise<Omit<NousResult, "attempts">> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(NOUS_CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Bearer key — never logged anywhere in this module.
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: NOUS_MODEL,
        // Map to OpenAI shape; drop any non-text fields (e.g. images) — the
        // Nous path is text-only and never taken on vision turns.
        messages: opts.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        // Floor the cap: reasoning + content share this budget (see header).
        // null/undefined stays uncapped.
        ...(opts.maxTokens != null
          ? { max_tokens: Math.max(opts.maxTokens, NOUS_MIN_MAX_TOKENS) }
          : {}),
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`nous ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string;
          reasoning?: string;
          reasoning_content?: string;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const msg = json.choices?.[0]?.message;
    const content = msg?.content ?? "";
    if (!content.trim()) {
      // Name the failure precisely. Reasoning text is NEVER substituted for
      // the answer — it is chain-of-thought, not the assistant's voice.
      const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
      const finish = json.choices?.[0]?.finish_reason ?? "unknown";
      throw new Error(
        reasoning.trim()
          ? `nous returned reasoning-only response (${reasoning.length}ch reasoning, finish=${finish}) — content empty`
          : `nous returned empty content (finish=${finish})`
      );
    }
    return {
      content,
      model: json.model || NOUS_MODEL,
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
      totalTokens: json.usage?.total_tokens ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the Nous chat-completions API (non-streamed POST) and return the
 * normalized result. THROWS on any failure so the caller answers locally and
 * SURFACES the reason (badge + audit — never a silent impersonation). The
 * API key is sent in the Authorization header and NEVER logged or returned.
 * Native fetch. One bounded retry on transient failures (5xx, empty,
 * reasoning-only) within NOUS_TOTAL_BUDGET_MS.
 */
export async function callNous(opts: {
  apiKey: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number | null;
}): Promise<NousResult> {
  const started = Date.now();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = NOUS_TOTAL_BUDGET_MS - (Date.now() - started);
    if (remaining < 5_000) break; // not enough budget for a meaningful attempt
    try {
      const r = await callNousOnce(opts, Math.min(NOUS_TIMEOUT_MS, remaining));
      return { ...r, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (!isRetryableNousError(e)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
