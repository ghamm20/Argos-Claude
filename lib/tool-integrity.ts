// lib/tool-integrity.ts
//
// Model-integrity guard (v2.3.8 doctrine) — the response-layer enforcement of
// ARGOS's "no fake success." When a tool call fails silently (parser rejects
// it, no result injected), the model fabricates results in narrative form and,
// when challenged, doubles down. The operator caught it; the system must catch
// it first.
//
// This module detects an assistant message that CLAIMS tool execution / data
// retrieval, with TWO safeguards against false positives:
//   1. NEGATION — "I did NOT check", "I have not run it" are truthful denials,
//      never flagged.
//   2. GROUNDING — a claim is only a violation when nothing real backed it.
//      STRONG tool-execution claims need a real tool run; SOFT retrieval claims
//      ("I searched", "I looked up") are also satisfied by vault retrieval /
//      memory recall / research this turn.
//
// Pure + dependency-free so it can be unit-tested directly.

// STRONG — claims of having INVOKED a tool / run a simulation / gotten a tool
// result. A real tool must have run this turn, or it is fabrication.
const STRONG_CLAIM_RES: RegExp[] = [
  /\b(the\s+)?tool\s+(was\s+|is\s+|has\s+been\s+)?(invoked|executed|ran|run|called|returned|reported|succeeded)\b/i,
  /\binvoked\s+the\b/i,
  /\b(the\s+)?simulation\s+(ran|has\s+run|was\s+run|completed|executed|finished|converged)\b/i,
  /\b(the\s+)?experiment\s+(ran|completed|executed|finished)\b/i,
  /\b(the\s+)?analysis\s+(ran|completed|finished|executed)\b/i,
  /\b(the\s+)?system\s+(executed|ran|processed)\b/i,
  /\bran\s+the\s+(simulation|experiment|tool|query|scan|analysis|integration|model|protocol|loop|check)\b/i,
  /\bi\s+(ran|executed|called|invoked|queried|pinged|launched|triggered)\b/i,
  /\bi('|\s+ha)?ve\s+(run|queried|executed|called|invoked|launched|triggered)\b/i,
  // named system / "the X tool" result attribution
  /\b([a-z][\w-]*)\s+(tool|integration|api|system|simulation)\s+(returned|reported|found|confirmed|shows?|showed|indicated?|responded|gave|output)\b/i,
  /\b(mirofish|oculus)\b[^.?!]{0,40}\b(returned|reported|found|confirmed|shows?|showed|ran|gave|output|converged)\b/i,
  /\b(the\s+)?(call|query|request|invocation)\s+(was\s+)?(executed|successful|succeeded|completed|returned|went\s+through)\b/i,
  /\b(the\s+)?tool\s+was\s+used\b/i,
  /\bi\s+(did|already)\s+(use|run|call|invoke|query)\b/i,
];

// SOFT — claims of having retrieved/looked up information. Satisfied by a tool
// OR by vault retrieval / memory recall / research this turn.
const SOFT_CLAIM_RES: RegExp[] = [
  /\bi\s+searched\b/i,
  /\bi\s+checked\b/i,
  /\bi\s+looked\s+(it\s+|that\s+|this\s+)?up\b/i,
  /\bi\s+retrieved\b/i,
  /\bi\s+fetched\b/i,
  /\bi('|\s+ha)?ve\s+(searched|checked|looked\s+up|retrieved|fetched)\b/i,
];

// Negation in the ~28 chars BEFORE a match → it's a truthful denial, not a claim.
const NEGATION_RE =
  /\b(not|never|no|without|unable|cannot|can'?t|couldn'?t|wouldn'?t|did(?:\s+not|n'?t)|do(?:\s+not|n'?t)|does(?:\s+not|n'?t)|have(?:\s+not|n'?t)|has(?:\s+not|n'?t)|had(?:\s+not|n'?t)|was(?:\s+not|n'?t)|were(?:\s+not|n'?t)|is(?:\s+not|n'?t)|fail(?:ed|s)?|unsuccessful|won'?t)\b[\s,'"-]*$/i;

function nonNegatedMatches(content: string, regexes: RegExp[]): string[] {
  const hits: string[] = [];
  for (const re of regexes) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(content)) !== null) {
      const before = content.slice(Math.max(0, m.index - 28), m.index);
      if (!NEGATION_RE.test(before)) hits.push(m[0].trim());
      if (m.index === g.lastIndex) g.lastIndex++; // avoid zero-width loop
    }
  }
  return Array.from(new Set(hits));
}

// Honest acknowledgements that a tool did NOT run (an attempt failed, approval
// is needed, the model doesn't know, etc.). Their presence means the model is
// being truthful about the absence of a result.
const HONESTY_DISCLAIMER_RE =
  /\b(not\s+(yet\s+)?(checked|run|ran|able|invoked|executed|connected|accessed|queried)|have\s+not|haven'?t|did\s+not|didn'?t|do\s+not\b|don'?t\b|cannot|can'?t|could\s+not|couldn'?t|unable|no\s+such\s+tool|does\s+not\s+exist|doesn'?t\s+exist|not\s+(a\s+)?(real|valid|known|available)\s+tool|requires?\s+(your\s+)?approval|need(s)?\s+(your\s+)?approval|awaiting\s+(your\s+)?approval|approval\s+(is\s+)?(required|needed)|attempt(ed)?\s+(failed|but)|the\s+attempt\s+failed|no\s+result|format\s+failed|i\s+will\s+(need\s+to|attempt|try)|let\s+me\s+(try|attempt)|i\s+am\s+(unable|not\s+able)|i\s+don'?t\s+know|i\s+do\s+not\s+know|haven'?t\s+(yet\s+)?(run|checked|queried))\b/i;

/** Did the operator explicitly COMMAND a tool this turn (e.g. "use
 *  mirofish_integration", "run the X tool", "access your weather tool")?
 *  Used by the structural guard — a command + no tool run + no honest disclaimer
 *  means the model answered as if the tool ran, no matter the phrasing. */
export function isExplicitToolRequest(userText: string, knownToolIds: readonly string[]): boolean {
  if (!userText) return false;
  const t = userText.toLowerCase();
  if (!/\b(use|using|run|access|query|invoke|call|execute|launch|fire\s*up|hit|ping|check\s+with|open\s+up)\b/.test(t)) return false;
  if (/\b(mirofish|oculus)\b/.test(t)) return true;
  if (/\b[a-z][\w-]*_(integration|search|tool|query|alert|sms|extract|generate|ops|exec|lookup|assess|report|crawl|reader|feed|hub|events|weather|research)\b/.test(t)) return true;
  if (/\b(your|the)\s+[a-z][\w-]*\s+tool\b/.test(t)) return true;
  for (const id of knownToolIds) {
    if (t.includes(id) || t.includes(id.replace(/_/g, " "))) return true;
  }
  return false;
}

export function hasHonestyDisclaimer(content: string): boolean {
  return HONESTY_DISCLAIMER_RE.test(content);
}

export interface IntegrityContext {
  /** A real tool (requestTool) ran/routed this turn. */
  toolRan: boolean;
  /** Any other real grounding occurred (vault retrieval hits, memory recall,
   *  research) — satisfies SOFT retrieval claims but not STRONG tool claims. */
  hadGrounding: boolean;
  /** The operator explicitly commanded a tool this turn. */
  explicitToolRequest?: boolean;
  /** v2.3.11 — the MODEL itself emitted a malformed tool tag this turn (a parse
   *  FAILURE: no executable call), yet produced a substantive answer anyway.
   *  A weak model (e.g. Bobby's) emits `<web_search {...}>` then fabricates a
   *  result JSON block — no real tool ran, and the phrasing evades the claim
   *  lists. This is fabrication: the model tried a tool, it didn't execute, and
   *  it answered as if it had. */
  attemptedToolButFailed?: boolean;
}

export interface IntegrityVerdict {
  violation: boolean;
  /** The specific claim phrases that triggered (for the violation log). */
  patterns: string[];
}

/**
 * v2.3.11 — detect a MALFORMED tool attempt: an angle-bracket tag whose NAME is
 * a real tool id, e.g. `<web_search {…}>` or `<open_meteo_weather {"lat":…}>`.
 * Weak models emit this instead of the required `<tool>{"id":"web_search",…}</tool>`,
 * so the parser never executes it — yet the model often fabricates a result
 * after it. The real `<tool>` wrapper is NOT matched ("tool" is not a tool id).
 */
export function hasMalformedToolTag(content: string, knownToolIds: readonly string[]): boolean {
  if (!content) return false;
  const known = new Set(knownToolIds);
  const re = /<\s*([a-z][a-z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (known.has(m[1])) return true;
  }
  return false;
}

/** Evaluate a finished assistant message against the integrity doctrine. */
export function evaluateIntegrity(content: string, ctx: IntegrityContext): IntegrityVerdict {
  if (!content) return { violation: false, patterns: [] };
  const strong = nonNegatedMatches(content, STRONG_CLAIM_RES);
  const soft = nonNegatedMatches(content, SOFT_CLAIM_RES);
  const grounded = ctx.toolRan || ctx.hadGrounding;
  const strongViolation = strong.length > 0 && !ctx.toolRan;
  const softViolation = soft.length > 0 && !grounded;
  // STRUCTURAL — a substantive answer that answers AS IF a tool ran, when none
  // did and nothing was honestly disclaimed. Two triggers:
  //   (a) the OPERATOR explicitly commanded a tool (explicitToolRequest), or
  //   (b) the MODEL itself emitted a malformed tool tag this turn
  //       (attemptedToolButFailed) and had no other grounding — it tried a tool,
  //       it didn't execute, and it answered anyway (Bobby's `<web_search …>` +
  //       fabricated JSON). Catches fabrications whose PHRASING evades the claim
  //       lists. 40-char floor skips terse honest replies; the honesty-disclaimer
  //       escape hatch keeps "I tried X but it failed" from being flagged.
  const structuralTrigger =
    (ctx.explicitToolRequest === true && !ctx.toolRan) ||
    (ctx.attemptedToolButFailed === true && !ctx.toolRan && !ctx.hadGrounding);
  const structuralViolation =
    structuralTrigger &&
    content.trim().length > 40 &&
    !hasHonestyDisclaimer(content);
  const patterns: string[] = [];
  if (strongViolation) patterns.push(...strong);
  if (softViolation) patterns.push(...soft);
  if (structuralViolation) {
    patterns.push(
      ctx.explicitToolRequest === true
        ? "substantive answer to an explicit tool command with no tool run and no honest disclaimer"
        : "substantive answer after a MALFORMED tool attempt (parse failure) with no tool run, no grounding, no honest disclaimer"
    );
  }
  return {
    violation: strongViolation || softViolation || structuralViolation,
    patterns: Array.from(new Set(patterns)),
  };
}

/** True when the message contains ANY (non-negated) tool/retrieval claim,
 *  regardless of grounding. Used by diagnostics. */
export function claimsToolUse(content: string): boolean {
  return nonNegatedMatches(content, STRONG_CLAIM_RES).length > 0 ||
    nonNegatedMatches(content, SOFT_CLAIM_RES).length > 0;
}

/** Back-compat thin wrapper: flag when a claim is present and no tool ran AND
 *  no other grounding occurred. */
export function shouldFlagFabricatedToolUse(content: string, toolRan: boolean, hadGrounding = false): boolean {
  return evaluateIntegrity(content, { toolRan, hadGrounding }).violation;
}

export const INTEGRITY_WARNING_REASON = "false_tool_claim";

/** Best-effort: which registered/known tool the model falsely claimed (for the
 *  violation log). Returns the first known tool name mentioned, or null. */
export function inferMissingTool(content: string, knownToolIds: readonly string[]): string | null {
  const lower = content.toLowerCase();
  for (const id of knownToolIds) {
    const bare = id.replace(/_/g, " ");
    if (lower.includes(id) || lower.includes(bare)) return id;
  }
  // common aliases the model uses in prose
  for (const [alias, id] of [["mirofish", "mirofish_integration"], ["oculus", "oculus_integration"], ["web search", "web_search"], ["search", "web_search"]]) {
    if (lower.includes(alias)) return id;
  }
  return null;
}

/** The operator-visible note appended when a turn claims tool execution that
 *  did not occur (doctrine spec, Layer 2 §3a). */
export function buildIntegrityWarning(): string {
  return [
    "",
    "",
    "⚠️ INTEGRITY VIOLATION: This response claims tool execution that did not occur.",
    "The model may have fabricated results. Verify independently before trusting.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 2c — MISREPRESENTATION guard (v2.3.9). v2.3.8 catches fabrication
// (a claim with no tool call). This catches the adjacent shape: a tool RAN,
// returned a clear NEGATIVE ("MiroFish not running"), and the model framed the
// completed call as pending ("I await the result") instead of surfacing the
// outcome. Truth is unconditional — a negative result is reported faithfully.
// ─────────────────────────────────────────────────────────────────────────

export interface ToolResultLike {
  toolId?: string;
  ok?: boolean;
  summary?: string | null;
  data?: unknown;
  error?: string | null;
}

const NEGATIVE_SUMMARY_RE =
  /\b(not\s+running|not\s+connected|not\s+available|not\s+reachable|not\s+found|no\s+results?\b|0\s+results|unavailable|unreachable|offline|is\s+down\b|went\s+down|404|timeout|timed\s+out|could\s+not|couldn'?t|failed|errored?|error\b|refused|no\s+such|disabled|empty\s+result)\b/i;

/** A tool return that is a clear negative/empty/error state. ok:true with
 *  connected:false still counts (the MiroFish case). */
export function isNegativeStateResult(r: ToolResultLike | null | undefined): boolean {
  if (!r) return false;
  if (r.ok === false) return true;
  if (r.error) return true;
  const d = (r.data ?? {}) as Record<string, unknown>;
  if (d.connected === false) return true;
  if (typeof d.status === "string" && /^(error|failed|not_found|down|offline|unavailable)$/i.test(d.status)) return true;
  if (Array.isArray((d as { results?: unknown[] }).results) && ((d as { results: unknown[] }).results.length === 0)) return true;
  const note = typeof d.note === "string" ? d.note : "";
  return NEGATIVE_SUMMARY_RE.test(`${r.summary ?? ""} ${note}`);
}

// Forward-looking framing of a COMPLETED call as still pending.
const FORWARD_LOOKING_RE =
  /\b(i\s+await|awaiting|await\s+(the\s+)?(result|response|output|return)|task\s+has\s+(begun|started|commenced)|(still\s+)?in[\s-]progress|i'?m\s+(now\s+)?(running|querying|processing)|currently\s+(running|querying|processing|executing)|is\s+(now\s+)?(running|processing|underway)|being\s+(processed|retrieved|prepared|generated|computed|fetched|compiled|gathered)|available\s+for\s+reporting|waiting\s+(for|on)|should\s+return|will\s+report\s+(back\s+)?(when|once)|once\s+(it|the\s+\w+)\s+(returns|completes|finishes)|pending\b|underway|stand\s+by|i\s+will\s+(update|report|let\s+you\s+know)\s+(you\s+)?(when|once|shortly)|results?\s+(are\s+)?(pending|forthcoming|incoming))\b/i;

// Honest surfacing of the negative outcome (so it is NOT a misrepresentation).
const SURFACES_NEGATIVE_RE =
  /\b(not\s+(currently\s+)?(running|connected|available|reachable|found|responding)|is\s?n'?t\s+(running|connected|available|reachable|responding)|was\s?n'?t\s+(running|connected|able|reachable)|no\s+result|0\s+results|unavailable|unreachable|offline|is\s+down|went\s+down|failed|errored?|error\b|could\s?n'?t|could\s+not|was(n'?t| not)\s+able|returned\s+(an?\s+)?(error|nothing|empty|negative)|came\s+back\s+(empty|negative)|is\s+(not\s+(currently\s+)?(running|available|connected)|down|offline)|did\s?n'?t\s+(connect|respond|return)|did\s+not\s+(connect|respond|return))\b/i;

// False-SUCCESS / false-availability framing of a call whose real result is
// negative: claims it ran successfully, retrieved the data, or that a result is
// now available — none of which is true when the actual return is "not running"
// / empty / error. Only ever evaluated when a NEGATIVE result is in context and
// the response does NOT surface it, so the negative-in-context precondition is
// what bounds false positives.
const FALSE_SUCCESS_RE =
  /\b(successfully\s+(invoked|ran|executed|called|completed|queried|retrieved|fetched|processed|connected)|invoked\s+[`'"\w.-]+\s+to\s+(retrieve|get|fetch|query|list|obtain|pull)|(i\s+have|i'?ve|now\s+have)\s+(the|its|your|retrieved|obtained|gathered)\s*\w*\s*(state|data|results?|status|answer|information|entities|list|snapshot)|results?\s+(is|are)\s+(now\s+)?(available|ready|here|in\s+context)|retrieved\s+the\s+(state|data|status|results?|list|snapshot)|the\s+\w+\s+(returned|provided|gave|yielded)\s+(the|its|a)\s+(state|data|results?|status)|available\s+(in\s+context\s+)?for\s+(immediate\s+)?reporting)\b/i;

export interface MisrepVerdict {
  violation: boolean;
  /** The negative summary that should have been surfaced. */
  summary: string | null;
  toolId: string | null;
}

/**
 * Detect misrepresentation: a NEGATIVE tool result is in context, and the
 * response either frames the completed call as still-pending (forward-looking)
 * OR claims false success/availability — in BOTH cases WITHOUT surfacing the
 * negative outcome. `negatives` are the negative-state results from this turn
 * AND the most recent prior turn in the session.
 */
export function detectMisrepresentation(content: string, negatives: ToolResultLike[]): MisrepVerdict {
  if (!content || !negatives || negatives.length === 0) return { violation: false, summary: null, toolId: null };
  // If the response honestly surfaces ANY negative outcome, it's not a
  // misrepresentation (it reported the result and may be awaiting a NEXT step).
  if (SURFACES_NEGATIVE_RE.test(content)) return { violation: false, summary: null, toolId: null };
  const neg = negatives[0];
  const summaryText = (neg.summary ?? "").trim();
  // Quoting the actual summary also counts as surfacing.
  if (summaryText.length > 8 && content.includes(summaryText.slice(0, Math.min(28, summaryText.length)))) {
    return { violation: false, summary: null, toolId: null };
  }
  // Two misrepresentation shapes: "still pending" OR "false success/available".
  const misrepresents = FORWARD_LOOKING_RE.test(content) || FALSE_SUCCESS_RE.test(content);
  if (!misrepresents) return { violation: false, summary: null, toolId: null };
  return { violation: true, summary: summaryText || "a negative result", toolId: neg.toolId ?? null };
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 2d — UNCITED-CLAIM guard (Phase 3 gate 5, 2026-06-10).
//
// The Phase 2 live proof surfaced the shape this catches: zero retrieval
// hits, truth mode on, and the model fabricated "The vault states that the
// Lunar Mining Colony allocated a total operating budget of $48 billion…"
// with NO citation. The false-citation gate counts [N] against hits, so an
// UNCITED vault attribution sailed through. This guard flags any sentence
// that attributes content to the vault/archive/corpus when it is not backed
// by a citation pointing at a real retrieval hit:
//   - hitCount === 0 → ANY affirmative vault attribution is unbacked
//   - hitCount  >  0 → the attributing sentence must carry an in-range [N]
//
// Judgment call (documented): honest ABSENCE statements ("the vault doesn't
// cover this", "no records of X in the vault") are excluded — retrieval
// found nothing and the model says so; that's the safe direction the
// retrieval-block instructions explicitly push toward.
//
// PHRASING-INDEPENDENT EXTENSION (Phase 8, owner rider from Phase 3 R2,
// 2026-06-10): the original guard only fired on "the vault states …". This
// widens the net to ANY phrasing that reports stored/source content — the
// SOURCE noun (vault/archive/corpus/index/record/document/text/passage/
// source/book/trilogy/canon) under ANY reporting verb, plus "according to /
// per the <source>". So the $48B-style fabrication is caught whether it's
// "the vault states", "the records show", "according to the document", or
// "per the archive".
//
// HONEST RESIDUAL (documented, not a defect): a TRULY unattributed factual
// claim ("The lunar budget is $48B.") is left UNFLAGGED on purpose — with no
// source-reporting phrasing it is indistinguishable from the persona answering
// from its own knowledge, which the retrieval block EXPLICITLY instructs Bart
// to do on a zero-hit turn ("answer from your own knowledge; do NOT claim a
// topic doesn't exist"). Flagging those would break legitimate canon answers.
// The guard catches CONTENT-ATTRIBUTION fabrication of any phrasing; it does
// not (and cannot soundly) police the model's own-knowledge claims.
// ─────────────────────────────────────────────────────────────────────────

const SOURCE_NOUN = "vault|archive|corpus|index|records?|documents?|text|passage|source|book|trilogy|canon";
const REPORT_VERB =
  "state|states|stated|say|says|said|show|shows|showed|record|records|recorded|contain|contains|contained|" +
  "indicate|indicates|indicated|confirm|confirms|confirmed|note|notes|noted|list|lists|listed|" +
  "document|documents|documented|describe|describes|described|mention|mentions|mentioned|read|reads";

const VAULT_ATTRIBUTION_RE = new RegExp(
  `\\b(?:` +
    // "the <source> <verb>" e.g. the records show, the document indicates
    `the\\s+(?:${SOURCE_NOUN})\\s+(?:${REPORT_VERB})` +
    `|` +
    // "according to / per / based on / as stated in the <source>"
    `(?:according\\s+to|per|based\\s+on|as\\s+(?:stated|written|recorded|noted)\\s+in)\\s+the\\s+(?:${SOURCE_NOUN})` +
  `)\\b`,
  "i"
);

const ABSENCE_CLAIM_RE =
  /\b(?:no\s+(?:records?|entries|entry|documents?|information|mention|data)|nothing|not\s+(?:contain|cover|mention|include)|doesn'?t|does\s+not|contains?\s+no)\b/i;

export interface UncitedClaimVerdict {
  violation: boolean;
  /** The attributing sentence that lacked a backing citation. */
  sentence: string | null;
  hitCount: number;
}

/** Detect a vault/canon attribution not backed by a real retrieval hit. */
export function detectUncitedVaultClaim(content: string, hitCount: number): UncitedClaimVerdict {
  if (!content) return { violation: false, sentence: null, hitCount };
  const sentences = content.split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    if (!VAULT_ATTRIBUTION_RE.test(s)) continue;
    if (ABSENCE_CLAIM_RE.test(s)) continue; // honest "vault has nothing" statement
    const cites = [...s.matchAll(/\[(\d{1,2})\]/g)].map((m) => parseInt(m[1], 10));
    const backed = cites.some((n) => n >= 1 && n <= hitCount);
    if (!backed) {
      return { violation: true, sentence: s.trim().slice(0, 240), hitCount };
    }
  }
  return { violation: false, sentence: null, hitCount };
}

/** Operator-visible note for an uncited vault/canon claim (Layer 2d). */
export function buildUncitedClaimWarning(sentence: string, hitCount: number): string {
  return [
    "",
    "",
    `⚠️ UNCITED CLAIM — This response attributes content to the vault ("${sentence.slice(0, 120)}…") ` +
      `but no retrieval hit backs it (${hitCount} hit${hitCount === 1 ? "" : "s"} this turn).`,
    "The vault may not contain this at all. Verify independently before trusting.",
  ].join("\n");
}

/** Operator-visible note for a misrepresented negative result (Layer 2c §4). */
export function buildMisrepresentationWarning(summary: string): string {
  return [
    "",
    "",
    `⚠️ MISREPRESENTATION — A tool returned a negative result ("${summary}") which is not surfaced in this response.`,
    "The tool call is not in-progress; it has completed with the above outcome.",
  ].join("\n");
}

/** Compact, model-facing record of the most recent tool results, so the model
 *  HAS the outcome in its context and cannot honestly claim to be "awaiting" it.
 *  Root-cause complement to the guard. */
export function buildRecentToolResultsBlock(results: ToolResultLike[]): string {
  const lines = results.slice(0, 4).map((r) => {
    const neg = isNegativeStateResult(r);
    const sum = (r.summary ?? (r.error ? `error: ${r.error}` : "(no summary)")).toString().slice(0, 300);
    return `- ${r.toolId ?? "tool"} → COMPLETED${neg ? " (NEGATIVE/empty)" : ""}. Result: "${sum}"`;
  });
  return [
    "RECENT TOOL ACTIVITY — these calls have ALREADY COMPLETED this conversation.",
    "Their results are below. Report them faithfully. Do NOT describe any of these",
    "as pending, in-progress, or 'awaiting a result' — they are finished. If a result",
    "is negative ('not running', 'no results', an error), say so plainly.",
    ...lines,
  ].join("\n");
}

// ── Next-turn corrective system injections (Layer 1 §5 + Layer 2 §4) ──

/** Injected when the PRIOR turn emitted a tool-shaped output the parser could
 *  not execute. */
export const PARSE_FAILURE_SYSTEM_NOTE = [
  "SYSTEM — TOOL PARSE FAILURE (previous turn):",
  "Your previous tool invocation could not be parsed. You did NOT successfully call any tool.",
  "Do NOT claim execution or describe any tool result. Either re-attempt with the EXACT format",
  '<tool>{"id":"<tool_id>","params":{ ... }}</tool>',
  "or tell the operator plainly that the attempt failed.",
].join("\n");

/** Injected when the PRIOR turn was flagged as an integrity violation
 *  (fabricated tool use). */
export const FABRICATION_SYSTEM_NOTE = [
  "SYSTEM — INTEGRITY VIOLATION (previous turn):",
  "Your previous response claimed tool execution that did not occur. This is a doctrine violation.",
  "You may not claim to use tools you did not successfully invoke. If you attempted a tool and got",
  "no result, say so. If you do not know something, say so. Correct the record now — do not defend",
  "the prior claim. Fabricating execution is the worst possible failure for an operator AI.",
].join("\n");

/** Injected when the PRIOR turn misrepresented a completed (negative) tool
 *  result as pending (Layer 2c §7). */
export function buildMisrepCorrectionNote(summary: string): string {
  return [
    "SYSTEM — MISREPRESENTATION (previous turn):",
    `Your previous response framed a completed tool call as pending. The tool returned "${summary}".`,
    "Always surface negative tool results faithfully. Do not soften outcomes by framing completed",
    "calls as in-progress or 'awaiting a result'. State the actual result now.",
  ].join("\n");
}
