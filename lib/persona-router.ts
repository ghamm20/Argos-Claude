// lib/persona-router.ts
//
// Phase 9 (2026-05-31) — AgenticSeek-inspired persona router.
//
// Studies Fosowl/agenticSeek's AgentRouter and reimplements its
// routing *architecture* natively in TypeScript — NO Python, NO
// transformers, NO AgenticSeek dependency. We borrow the design, not
// the code.
//
// AgenticSeek's pipeline (sources/router.py):
//   1. estimate_complexity() — a few-shot AdaptiveClassifier labels
//      the query LOW/HIGH. HIGH (or low-confidence) → route to the
//      *planner* agent (the orchestrator).
//   2. router_vote() — a BART zero-shot classifier and a learned
//      AdaptiveClassifier each predict a category; their confidences
//      are normalized and the higher-confidence label wins.
//   ( "BART" there = facebook/bart-large-mnli, the model — NOT ARGOS's
//     persona Bartimaeus. Naming coincidence; see PHASE_9_REPORT.md. )
//
// ARGOS port:
//   * Stage 1 — COMPLEXITY GATE. Lexical multi-step detection. A
//     genuinely multi-step / strategic ask biases hard toward
//     Bartimaeus (our orchestrator), mirroring AgenticSeek's
//     complexity→planner rule.
//   * Stage 2 — KEYWORD CLASSIFIER (fast path, NO model). Weighted
//     keyword/regex scoring per persona, deterministic, sub-millisecond.
//     This replaces BOTH of AgenticSeek's trained classifiers with a
//     rule-based scorer so ARGOS adds zero runtime deps and zero
//     latency on the happy path.
//   * Stage 3 — LLM FALLBACK (only if keyword confidence < threshold).
//     Asks the *already-running* Ollama model to classify, then votes
//     with the keyword lean (AgenticSeek's normalized vote). Never
//     fires on the happy path; never blocks chat.
//
// Doctrine:
//   - SUGGESTION ONLY. The router never changes which persona answers;
//     callers decide what to do with the recommendation. Manual
//     selection always wins.
//   - GRACEFUL. Every public function is total: it never throws. On
//     any internal error it returns a low-confidence "stay put" result.
//   - ZERO HAPPY-PATH LATENCY. classifyByKeyword() is pure CPU string
//     work. The chat route uses ONLY this; the Ollama fallback is
//     opt-in (routePersona({ useModel: true })).

import { type PersonaId } from "./personas";

export const PERSONA_IDS: PersonaId[] = [
  "bartimaeus",
  "juniper",
  "sage",
  "bobby",
];

/** Above this, the recommendation is surfaced ("Routing to X"); below,
 *  the caller stays on the current persona silently. Matches the
 *  directive's 0.7 gate. */
export const ROUTE_CONFIDENCE_THRESHOLD = 0.7;

export type RouteMethod = "keyword" | "llm" | "vote" | "none";

export interface RouteResult {
  /** Recommended persona, or null when there's no signal at all. */
  recommended: PersonaId | null;
  /** 0..1. >= ROUTE_CONFIDENCE_THRESHOLD ⇒ surface; below ⇒ stay put. */
  confidence: number;
  method: RouteMethod;
  complexity: "low" | "high";
  /** Per-persona raw scores from the keyword stage (for transparency). */
  scores: Record<PersonaId, number>;
  /** Short human explanation (matched signals / why). */
  reason: string;
}

// ---------------------------------------------------------------------
// Keyword tables. Weight convention: 3 = domain-defining, 2 = strong,
// 1 = weak/ambiguous. Patterns are matched case-insensitively. A
// pattern containing a space or a non-word symbol is matched as a
// (lowercased) substring; a bare alphanumeric word is matched with
// word boundaries so "loop" doesn't fire inside "loophole".
// ---------------------------------------------------------------------

type Weighted = [pattern: string, weight: number];

const BART_KW: Weighted[] = [
  // verification / logic / legal / strategic — Bart's domain
  ["legal", 3], ["lawful", 3], ["law", 2], ["probable cause", 3],
  ["court", 3], ["ruling", 3], ["precedent", 3], ["statute", 3],
  ["constitutional", 3], ["jurisdiction", 3], ["liability", 2],
  ["verify", 3], ["verification", 3], ["validate", 3], ["fact-check", 3],
  ["fact check", 3], ["prove", 3], ["proof", 3], ["logic", 3],
  ["logical", 3], ["reasoning", 3], ["rationale", 2], ["justify", 2],
  ["strategy", 3], ["strategic", 3], ["framework", 2], ["doctrine", 3],
  ["governance", 3], ["policy", 2], ["compliance", 2], ["audit", 2],
  ["due diligence", 3], ["risk assessment", 3], ["threat model", 3],
  ["trade-off", 2], ["tradeoff", 2], ["evaluate", 2], ["assess", 2],
  ["standard", 2], ["criteria", 2], ["decision", 1], ["should we", 2],
  ["is it true", 3], ["does it hold", 3],
  // orchestration / multi-step planning — Bart orchestrates
  ["plan", 3], ["roadmap", 3], ["rollout", 3], ["orchestrate", 3],
  ["multi-step", 3], ["phased", 2], ["phase", 2], ["milestone", 2],
  ["end-to-end", 2], ["coordinate", 2],
];

const JUNIPER_KW: Weighted[] = [
  // casual / conversational / emotional — Juniper's domain
  ["feeling", 3], ["overwhelmed", 3], ["overwhelm", 3], ["stressed", 3],
  ["stress", 2], ["anxious", 3], ["anxiety", 3], ["lonely", 3],
  ["sad", 3], ["depressed", 3], ["demoralized", 3], ["exhausted", 3],
  ["burnt out", 3], ["burned out", 3], ["burnout", 3], ["frustrated", 3],
  ["worried", 3], ["scared", 3], ["nervous", 3], ["hopeless", 3],
  ["vent", 3], ["i'm struggling", 3], ["struggling", 2], ["cope", 2],
  ["how are you", 3], ["talk to me", 3], ["let's chat", 3],
  ["i need to talk", 3], ["cheer me up", 3], ["motivation", 2],
  ["encourage", 2], ["reassure", 2], ["comfort", 2], ["mood", 2],
  ["hello", 2], ["hey there", 2], ["good morning", 2], ["thanks", 1],
  ["how's it going", 3], ["how is it going", 3],
];

const SAGE_KW: Weighted[] = [
  // research / synthesis / citation — Sage's domain
  ["research", 3], ["summarize", 3], ["summary", 3], ["synthesis", 3],
  ["synthesize", 3], ["literature", 3], ["papers", 3], ["paper", 2],
  ["study", 2], ["studies", 3], ["cite", 3], ["citation", 3],
  ["citations", 3], ["sources", 3], ["source", 1], ["survey", 3],
  ["overview", 2], ["state of the art", 3], ["trends", 3], ["trend", 2],
  ["latest", 2], ["recent", 2], ["findings", 3], ["deep dive", 3],
  ["whitepaper", 3], ["peer-reviewed", 3], ["arxiv", 3], ["report on", 2],
  ["what does the research", 3], ["compare approaches", 3],
  ["tell me about", 2], ["explain the", 1], ["background on", 2],
];

const BOBBY_KW: Weighted[] = [
  // code / technical / debugging — Bobby's domain
  ["code", 3], ["coding", 3], ["function", 3], ["for loop", 3],
  ["while loop", 3], ["loop", 2], ["bug", 3], ["debug", 3],
  ["debugging", 3], ["error", 3], ["exception", 3], ["compile", 3],
  ["compiler", 3], ["syntax", 3], ["stack trace", 3], ["traceback", 3],
  ["null pointer", 3], ["segfault", 3], ["keep breaking", 3],
  ["keeps breaking", 3], ["not working", 2], ["won't run", 2],
  ["refactor", 3], ["variable", 2], ["array", 2], ["regex", 3],
  ["endpoint", 2], ["npm", 3], ["pip install", 3], ["git", 2],
  ["docker", 2], ["build error", 3], ["type error", 3],
  ["undefined", 2], ["returns undefined", 3], ["script", 2],
  ["implement", 1], ["class", 1], ["method", 1], ["database", 2],
  ["sql query", 3],
  // languages / frameworks
  ["python", 3], ["javascript", 3], ["typescript", 3], ["java", 3],
  ["c++", 3], ["c#", 3], ["rust", 3], ["golang", 3], ["bash", 3],
  ["react", 3], ["node.js", 3], ["nodejs", 3], ["sql", 2],
];

const KW_TABLE: Record<PersonaId, Weighted[]> = {
  bartimaeus: BART_KW,
  juniper: JUNIPER_KW,
  sage: SAGE_KW,
  bobby: BOBBY_KW,
};

// Multi-step / complexity signals. Two or more distinct hits (or a
// planning verb + a staging noun) marks the query HIGH complexity and
// hands it to Bartimaeus to orchestrate — AgenticSeek's complexity→
// planner rule, ported.
const COMPLEXITY_SIGNALS: string[] = [
  "plan", "phases", "phase", "rollout", "roadmap", "step 1", "steps",
  "multi-step", "multistep", "end-to-end", "first then", "then ",
  "after that", "followed by", "stage 1", "stages", "milestones",
  "orchestrate", "design and implement", "design and build",
  "break it down", "3-phase", "two-phase", "three-phase",
];

const COMPLEXITY_BART_BOOST = 4;
/** One domain-defining keyword saturates "evidence". */
const EVIDENCE_SATURATION = 3;

function emptyScores(): Record<PersonaId, number> {
  return { bartimaeus: 0, juniper: 0, sage: 0, bobby: 0 };
}

/** Build a matcher for a keyword. Word-boundary for bare words;
 *  substring for multiword / symbol patterns. */
function matches(haystack: string, pattern: string): boolean {
  if (/^[a-z0-9]+$/i.test(pattern)) {
    // bare alphanumeric word → word boundary
    return new RegExp(`\\b${pattern}\\b`, "i").test(haystack);
  }
  // multiword or has symbols → lowercase substring
  return haystack.includes(pattern.toLowerCase());
}

function countComplexitySignals(lower: string): number {
  let n = 0;
  for (const sig of COMPLEXITY_SIGNALS) {
    if (lower.includes(sig)) n++;
  }
  return n;
}

/**
 * Stage 1 + 2: deterministic keyword classifier. Pure CPU, no model,
 * sub-millisecond. NEVER throws. Returns a full RouteResult with
 * method "keyword" (or "none" if nothing matched).
 */
export function classifyByKeyword(query: string): RouteResult {
  const scores = emptyScores();
  try {
    const text = (query ?? "").toString();
    const lower = text.toLowerCase().trim();
    if (lower.length === 0) {
      return {
        recommended: null,
        confidence: 0,
        method: "none",
        complexity: "low",
        scores,
        reason: "empty query",
      };
    }

    // Stage 2 — per-persona weighted keyword scoring.
    const matched: Record<PersonaId, string[]> = {
      bartimaeus: [], juniper: [], sage: [], bobby: [],
    };
    for (const persona of PERSONA_IDS) {
      for (const [pattern, weight] of KW_TABLE[persona]) {
        if (matches(lower, pattern)) {
          scores[persona] += weight;
          matched[persona].push(pattern);
        }
      }
    }

    // Stage 1 — complexity gate. Multi-step ⇒ orchestrate (Bart).
    const complexityHits = countComplexitySignals(lower);
    const complexity: "low" | "high" = complexityHits >= 2 ? "high" : "low";
    if (complexity === "high") {
      scores.bartimaeus += COMPLEXITY_BART_BOOST;
      matched.bartimaeus.push(`complexity:${complexityHits}`);
    }

    // Pick the winner.
    const ranked = PERSONA_IDS
      .map((p) => [p, scores[p]] as const)
      .sort((a, b) => b[1] - a[1]);
    const [topPersona, topScore] = ranked[0];
    const secondScore = ranked[1][1];
    const total = PERSONA_IDS.reduce((s, p) => s + scores[p], 0);

    if (topScore <= 0) {
      return {
        recommended: null,
        confidence: 0,
        method: "none",
        complexity,
        scores,
        reason: "no keyword signal",
      };
    }

    // Confidence = evidence × purity-weighted dominance.
    //   evidence — how much defining signal we have (saturates at 1)
    //   purity   — how dominant the winner is over the field
    const evidence = Math.min(1, topScore / EVIDENCE_SATURATION);
    const purity = topScore / total; // 1.0 when winner is uncontested
    const confidence =
      Math.round(evidence * (0.5 + 0.5 * purity) * 100) / 100;

    const reasonBits = matched[topPersona].slice(0, 5).join(", ");
    const margin = topScore - secondScore;
    return {
      recommended: topPersona,
      confidence,
      method: "keyword",
      complexity,
      scores,
      reason: `keyword: ${topPersona} via [${reasonBits}] (score ${topScore}, margin ${margin}${
        complexity === "high" ? ", complexity=high" : ""
      })`,
    };
  } catch (e) {
    // Total function — never throw. Degrade to "stay put".
    return {
      recommended: null,
      confidence: 0,
      method: "none",
      complexity: "low",
      scores,
      reason: `keyword classifier error (degraded): ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

// ---------------------------------------------------------------------
// Stage 3 — LLM fallback (opt-in). Asks the already-running Ollama
// model to classify into one of the four persona ids. Only meant to be
// called when keyword confidence < threshold. NEVER throws — on any
// failure it returns the keyword result unchanged.
// ---------------------------------------------------------------------

const LLM_CLASSIFY_TIMEOUT_MS = 8_000;

const CLASSIFY_PROMPT = (query: string) =>
  [
    "You are a query router. Classify the user's message into EXACTLY ONE category:",
    "- bartimaeus = verification, logic, legal/strategic reasoning, multi-step planning/orchestration",
    "- juniper = casual conversation, emotional support, venting, small talk",
    "- sage = research, summarization, synthesis, citations, surveying a topic",
    "- bobby = code, debugging, technical/programming questions",
    "",
    `User message: """${query.slice(0, 600)}"""`,
    "",
    'Answer with ONLY the single category word (bartimaeus, juniper, sage, or bobby). No punctuation, no explanation.',
  ].join("\n");

function parsePersonaFromText(text: string): PersonaId | null {
  const lower = (text ?? "").toLowerCase();
  // First explicit id wins.
  for (const p of PERSONA_IDS) {
    if (new RegExp(`\\b${p}\\b`).test(lower)) return p;
  }
  return null;
}

interface RoutePersonaOpts {
  /** Enable the Ollama fallback when keyword confidence is low. */
  useModel?: boolean;
  /** Ollama model id to ask. Required for the fallback to fire. */
  model?: string;
  /** Ollama base, e.g. http://127.0.0.1:11434. Required for fallback. */
  ollamaBase?: string;
  /** Abort signal passthrough. */
  signal?: AbortSignal;
}

/**
 * Full router: keyword first; if confidence < threshold AND a model +
 * base are supplied AND useModel is set, ask Ollama and vote. NEVER
 * throws. The chat happy-path should NOT set useModel (keeps latency
 * at zero); /api/route and deliberate callers can opt in.
 */
export async function routePersona(
  query: string,
  opts: RoutePersonaOpts = {}
): Promise<RouteResult> {
  const kw = classifyByKeyword(query);

  // Happy path: keyword already confident → done, no model touched.
  if (kw.confidence >= ROUTE_CONFIDENCE_THRESHOLD) return kw;

  // Fallback gated on explicit opt-in + a reachable model.
  if (!opts.useModel || !opts.model || !opts.ollamaBase) return kw;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_CLASSIFY_TIMEOUT_MS);
    let llmPersona: PersonaId | null = null;
    try {
      const res = await fetch(`${opts.ollamaBase}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          prompt: CLASSIFY_PROMPT(query),
          stream: false,
          think: false,
          options: { temperature: 0, num_predict: 8 },
        }),
        signal: opts.signal ?? controller.signal,
      });
      if (res.ok) {
        const j = (await res.json()) as { response?: string };
        llmPersona = parsePersonaFromText(j.response ?? "");
      }
    } finally {
      clearTimeout(timer);
    }

    if (!llmPersona) return kw; // model unhelpful → keep keyword result

    // Vote (AgenticSeek-style): if the LLM agrees with a nonzero
    // keyword lean, confidence is high; if it disagrees (keyword was
    // weak by definition here), trust the LLM but keep confidence
    // modest so it's a soft suggestion.
    const agrees = kw.recommended === llmPersona;
    if (agrees) {
      return {
        ...kw,
        recommended: llmPersona,
        confidence: Math.max(kw.confidence, 0.85),
        method: "vote",
        reason: `vote: keyword + LLM agree on ${llmPersona}`,
      };
    }
    return {
      ...kw,
      recommended: llmPersona,
      confidence: 0.72,
      method: "llm",
      reason: `llm: model chose ${llmPersona} (keyword was low-confidence ${kw.recommended ?? "none"} @ ${kw.confidence})`,
    };
  } catch (e) {
    // Any fallback failure → keyword result, never throw.
    return {
      ...kw,
      reason: `${kw.reason}; llm fallback failed (degraded): ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}
