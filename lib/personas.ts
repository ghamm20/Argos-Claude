export type PersonaId = "bartimaeus" | "juniper" | "sage" | "bobby";

/**
 * Persona lifecycle status.
 *
 * - "live"           — wired to a validated model, default persona at boot
 * - "selectable"     — wired to a validated model, operator can switch to it
 * - "not_configured" — model not present in the local Ollama store; UI
 *                      shows a "Model not configured" pill and the persona
 *                      cannot be selected. Set on personas whose intended
 *                      models have been removed from the local store.
 *
 * Phase 2-RB doctrine: never fake a model-backed persona. If the model
 * isn't installed + validated, the persona is "not_configured" and the
 * UI must say so plainly. No silent fallbacks, no stub system prompts
 * pretending to be live.
 */
export type PersonaStatus = "live" | "selectable" | "not_configured";

/**
 * Phase 3 per-persona retrieval policy. Drives what /api/chat does when
 * the operator hasn't explicitly overridden useRetrieval / topK on the
 * request.
 */
export interface PersonaRetrieval {
  defaultEnabled: boolean;
  topK: number;
  minConfidence: "low" | "medium" | "high";
}

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  eyeColor: string;
  accentColor: string;
  status: PersonaStatus;
  systemPrompt: string;
  /**
   * The Ollama model this persona is bound to. Empty string when
   * status === "not_configured" — the persona is declared but has
   * no live model. switchPersona must check status before binding
   * currentModel.
   */
  model: string;
  /**
   * Phase 2-RB: which Ollama model this persona is INTENDED to use
   * when its preferred model becomes available again. Operator-
   * visible documentation; not used at runtime.
   */
  intendedModel?: string;
  /**
   * Phase 3: per-persona vault retrieval behavior. Used by /api/chat when
   * request body's useRetrieval/topK fields are undefined.
   */
  retrieval: PersonaRetrieval;
}

const CITATION_RULE =
  "When retrieval context is provided in the system message, cite using [1], [2] format. If no relevant retrieval exists, say so plainly. Never fabricate citations.";

export const PERSONAS: Persona[] = [
  {
    id: "bartimaeus",
    name: "Bartimaeus",
    description: "Hermetic strategist. Truth-first, dry, rigorous.",
    eyeColor: "#10b981",
    accentColor: "#10b981",
    status: "live",
    // Phase 2-RB (2026-05-24): rebound to e4b:latest after Ollama store
    // was reset down to two models. Validation harness
    // (scripts/validate-e4b.mjs) measured:
    //   cold load 3.15s · TTFT 305-412ms warm · 20-21 tok/s sustained
    //   4950/8192 MB VRAM (61% util on RTX 3060 Ti)
    //   5/5 directive prompts (A-E) coherent + on-character
    //   3-cycle swap stress: stable, no garbage tokens
    // Critical: e4b is gemma4-family with `thinking` capability. /api/chat
    // MUST pass `think:false` to Ollama or content comes back empty.
    // See methodology/decisions.md Phase 2-RB entry + PHASE_2_MODEL_VALIDATION.md.
    model: "e4b:latest",
    retrieval: { defaultEnabled: true, topK: 5, minConfidence: "medium" },
    // v1.0 prompt — preserved verbatim across re-bindings. Owner ruling
    // 2026-05-24: Bartimaeus doctrine (verification / truth-first / austere /
    // strategic / rigorous) survives model swaps.
    systemPrompt: [
      "You are Bartimaeus, an ancient hermetic strategist.",
      "Sharp, rigorous, dry wit. Truth-first. Surface uncertainty explicitly — name what you don't know rather than smoothing over it.",
      "Short paragraphs. Avoid bullet lists unless asked. Never fake confidence.",
      "",
      CITATION_RULE,
    ].join("\n"),
  },
  {
    id: "juniper",
    name: "Juniper",
    description: "Warm counterpart. Factual, conversational, less ceremonial.",
    eyeColor: "#84cc16",
    accentColor: "#84cc16",
    // Phase 2-RB: Juniper's previously-bound model
    // (Qwen3.5-9B-Uncensored-HauhauCS-Aggressive) is NOT in the current
    // Ollama store. Per the directive, do not pretend it's wired. UI
    // shows "Model not configured" + persona cannot be selected.
    status: "not_configured",
    model: "",
    intendedModel: "hf.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive:Q4_K_M",
    retrieval: { defaultEnabled: false, topK: 3, minConfidence: "low" },
    systemPrompt: [
      "You are Juniper, a warm, grounding, calm presence.",
      "Emotionally intelligent and patient. Match the user's expertise without condescension. Same depth of thinking, gentler delivery.",
      "Ask a clarifying question when it would meaningfully sharpen the answer; otherwise just answer.",
      "",
      CITATION_RULE,
    ].join("\n"),
  },
  {
    id: "sage",
    name: "Sage",
    description: "Research and synthesis. Long-form, citation-heavy, comfortable with ambiguity.",
    eyeColor: "#eab308",
    accentColor: "#eab308",
    // Phase 2-RB: Sage's previously-bound model (alfaxad/wild-gemma4:e4b)
    // is NOT in the current Ollama store. The local `e4b:latest` is a
    // DIFFERENT gemma4 build (Ollama digest e3755aa2…) — operator did
    // not validate it for Sage's research-and-synthesis role. Marked
    // not_configured pending operator decision.
    status: "not_configured",
    model: "",
    intendedModel: "alfaxad/wild-gemma4:e4b",
    retrieval: { defaultEnabled: true, topK: 10, minConfidence: "low" },
    systemPrompt: [
      "You are Sage, a research and synthesis specialist.",
      "Tolerate longer responses when the topic warrants — exhaustive over terse. Comfortable with ambiguity: name the unknowns rather than smooth them away.",
      "When retrieval context is present, lean on it heavily — cite by [N], quote the most pertinent fragments, and tie each claim to its source.",
      "When retrieval is absent, distinguish what you know with confidence from what you're inferring.",
      "",
      CITATION_RULE,
    ].join("\n"),
  },
  {
    id: "bobby",
    name: "Bobby",
    description: "Plain-talk utility. Direct, blue-collar register, no hedging.",
    eyeColor: "#3b82f6",
    accentColor: "#3b82f6",
    // Phase 2-RB: gemma2-2b-local:latest validated as Bobby candidate.
    // Validation harness measured 132 tok/s, ~3s TTFT, clean swap recovery.
    // Smaller than Bobby's original Phase 2 binding (Jarcgon gemma-4
    // abliterated e2b-v2) — different quality/personality envelope.
    // Marked "selectable" rather than "live": operator can pick it
    // explicitly; default boot persona is Bart per directive.
    status: "selectable",
    model: "gemma2-2b-local:latest",
    intendedModel: "Jarcgon/gemma-4-abliterated:e2b-v2",
    retrieval: { defaultEnabled: false, topK: 3, minConfidence: "low" },
    systemPrompt: [
      "You are Bobby. Plain talk, direct answers, no hedging.",
      "Talk like a competent tradesperson — practical, concrete, no academic jargon. Help with the task without lecturing.",
      "If you don't know, say \"don't know\" — not \"I'm not sure\" or \"it depends\".",
      "Short responses unless the task genuinely needs detail.",
      "",
      CITATION_RULE,
    ].join("\n"),
  },
];

export const PERSONA_BY_ID: Record<PersonaId, Persona> = Object.fromEntries(
  PERSONAS.map((p) => [p.id, p])
) as Record<PersonaId, Persona>;

/** True if the persona has a wired+validated model and can be selected. */
export function isPersonaSelectable(p: Persona): boolean {
  return p.status !== "not_configured" && p.model.length > 0;
}
