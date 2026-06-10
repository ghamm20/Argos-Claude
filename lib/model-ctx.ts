// lib/model-ctx.ts
//
// Phase 1.5 Condition 2 (2026-06-10) — context-window floor for models whose
// modelfile does not set num_ctx.
//
// Root cause of the chronic auth-smoke "operator-chat-1-char" failure
// (verbatim evidence in scripts/diag-empty-content.mjs dumps): the operator-
// mode system prompt is ~4095 tokens. Ollama's DEFAULT context window is
// 4096 when the modelfile sets no num_ctx — the prompt saturates the whole
// window and generation dies after 1 token (done_reason:"length",
// prompt_eval_count:4095, eval_count:1). gemma-4 (Bart/Sage) was never
// affected because its modelfile sets num_ctx 131072 explicitly; Qwen3.5
// (Juniper) sets none, so every operator-prompt turn on it was dead on
// arrival. Architecture-compat issue, NOT a model defect — the model itself
// supports 262k context.
//
// Fix discipline: we only FLOOR the broken case. If the modelfile declares
// its own num_ctx, the modelfile governs and we send nothing — zero behavior
// change for working models. If /api/show fails, we send nothing (original
// behavior). Hardware envelope (Rule 9): 16384 on the lean tier keeps KV
// cache modest while giving the ~4.1k operator prompt + history + response
// 4x headroom.

import { getOllamaBase } from "./ollama-config";

export const FALLBACK_NUM_CTX = 16384;

/** model → num_ctx to send (number) or null (modelfile governs / unknown).
 *  Per-process cache: one /api/show per model per server lifetime. */
const cache = new Map<string, number | null>();

export async function resolveNumCtx(model: string): Promise<number | null> {
  if (cache.has(model)) return cache.get(model) ?? null;
  let result: number | null = null;
  try {
    const r = await fetch(`${getOllamaBase()}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const j = (await r.json()) as { parameters?: string };
      const declaresNumCtx = /(^|\n)\s*num_ctx\s+\d+/.test(j.parameters ?? "");
      result = declaresNumCtx ? null : FALLBACK_NUM_CTX;
    }
  } catch {
    // Ollama unreachable or slow — change nothing; the chat call itself
    // will surface the real connectivity error.
    result = null;
  }
  cache.set(model, result);
  return result;
}
