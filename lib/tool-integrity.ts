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
}

export interface IntegrityVerdict {
  violation: boolean;
  /** The specific claim phrases that triggered (for the violation log). */
  patterns: string[];
}

/** Evaluate a finished assistant message against the integrity doctrine. */
export function evaluateIntegrity(content: string, ctx: IntegrityContext): IntegrityVerdict {
  if (!content) return { violation: false, patterns: [] };
  const strong = nonNegatedMatches(content, STRONG_CLAIM_RES);
  const soft = nonNegatedMatches(content, SOFT_CLAIM_RES);
  const grounded = ctx.toolRan || ctx.hadGrounding;
  const strongViolation = strong.length > 0 && !ctx.toolRan;
  const softViolation = soft.length > 0 && !grounded;
  // STRUCTURAL — the operator explicitly commanded a tool, NO tool ran, and the
  // model neither emitted a parseable tool nor honestly disclaimed. It answered
  // as if the tool ran. Catches fabrications whose PHRASING evades the pattern
  // lists (e.g. "the narrative thread shows an entropy spike near Sector
  // Gamma-7" with no tool call). 40-char floor skips terse honest replies.
  const structuralViolation =
    ctx.explicitToolRequest === true &&
    !ctx.toolRan &&
    content.trim().length > 40 &&
    !hasHonestyDisclaimer(content);
  const patterns: string[] = [];
  if (strongViolation) patterns.push(...strong);
  if (softViolation) patterns.push(...soft);
  if (structuralViolation) patterns.push("substantive answer to an explicit tool command with no tool run and no honest disclaimer");
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
