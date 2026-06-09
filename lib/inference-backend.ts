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
// HONESTY DOCTRINE (Phase A):
//   - The ONLY cloud model wired is NOUS_MODEL below. Never the paid 550b
//     sibling (nvidia/nemotron-3-ultra-550b-a55b) or any ~anthropic / ~google
//     / ~openai proxy (those are billed per token).
//   - callNous returns the EXACT model the API echoed back; the caller logs
//     that literal string, never a generic "nous" label.
//   - Any failure (missing key, non-2xx, timeout, empty body) THROWS so the
//     caller can fall back to local silently and record the reason. We never
//     fabricate a response or a backend label.
//   - No new npm deps: native fetch only.

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

/** Per-call abort budget for the Nous request (directive: 30s). */
const NOUS_TIMEOUT_MS = 30_000;

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
}

/**
 * Call the Nous chat-completions API (non-streamed, single POST) and return
 * the normalized result. THROWS on any failure so the caller falls back to
 * local. The API key is sent in the Authorization header and NEVER logged or
 * returned. Native fetch, 30s abort.
 */
export async function callNous(opts: {
  apiKey: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number | null;
}): Promise<NousResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOUS_TIMEOUT_MS);
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
        ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
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
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      throw new Error("nous returned empty content");
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
