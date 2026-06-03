// lib/tool-integrity.ts
//
// Model-integrity guard (v2.3.8) — the doctrine backstop. ARGOS was built on
// "no fake success." When a tool call fails silently (parser rejects it, no
// result injected), the model in later turns FABRICATES results as if the call
// ran — and defends the fabrication when challenged. The operator caught it;
// the system should have caught it first.
//
// This module detects a final assistant message that CLAIMS tool execution.
// The chat route fires the warning only when such a claim is present AND no
// tool actually ran this turn (no result, no audit entry) — i.e. the claim is
// unbacked. Pure + dependency-free so it can be unit-tested directly.

// First-person / attributive claims of having INVOKED a tool or external
// system and gotten a result. Deliberately anchored on tool/simulation/
// external-system language (not vague "I think") so it targets execution
// claims, not advice ("you could use a tool"). The route only acts on a match
// when no tool ran, so a borderline match on a no-tool turn is still a true
// positive (the model asserted an action the system never performed).
const FALSE_TOOL_CLAIM_RE = new RegExp(
  [
    // "the tool was invoked", "tool executed/ran/returned/reported"
    "\\b(the\\s+)?tool\\s+(was\\s+)?(invoked|executed|ran|run|called|returned|reported|succeeded)\\b",
    "\\binvoked\\s+the\\b",
    // "the simulation ran/completed/executed"
    "\\b(the\\s+)?simulation\\s+(ran|has\\s+run|was\\s+run|completed|executed|finished)\\b",
    // "ran the simulation/experiment/tool/query/scan"
    "\\bran\\s+the\\s+(simulation|experiment|tool|query|scan|analysis|integration|model|check)\\b",
    // first-person execution: "I ran/executed/called/invoked/queried/fetched/..."
    "\\bi\\s+(ran|executed|called|invoked|queried|fetched|pinged|launched|triggered)\\b",
    // named-system result attribution: "MiroFish returned/found/reported/shows"
    "\\b(mirofish|oculus|the\\s+\\w+\\s+(tool|integration|api|system|simulation))\\s+(tool\\s+|integration\\s+)?(returned|reported|found|confirmed|shows?|showed|indicated?|responded|gave|output)\\b",
    // "the call/query/request executed/succeeded/returned"
    "\\b(the\\s+)?(call|query|request|invocation)\\s+(was\\s+)?(executed|successful|succeeded|completed|returned|went\\s+through)\\b",
    // perfect tense: "I've run/queried/executed/called/invoked the ..."
    "\\bi('|\\s+ha)?ve\\s+(run|queried|executed|called|invoked|launched)\\b",
    // explicit affirmation of use under challenge: "yes, the tool was used", "the tool was used"
    "\\b(the\\s+)?tool\\s+was\\s+used\\b",
    "\\bi\\s+(did|already)\\s+(use|run|call|invoke|query)\\b",
  ].join("|"),
  "i"
);

/** True when the assistant message claims it executed/invoked a tool or
 *  external system (and, by implication, got a result). */
export function claimsToolUse(content: string): boolean {
  if (!content) return false;
  return FALSE_TOOL_CLAIM_RE.test(content);
}

/** The integrity decision for a finished turn. `toolRan` = did ANY tool (forced
 *  current-facts tool OR a model-initiated, parsed call) run/route this turn. */
export function shouldFlagFabricatedToolUse(content: string, toolRan: boolean): boolean {
  return !toolRan && claimsToolUse(content);
}

export const INTEGRITY_WARNING_REASON = "false_tool_claim";

/** The operator-visible note appended to the assistant message when a turn
 *  claims tool execution that did not occur. */
export function buildIntegrityWarning(): string {
  return [
    "",
    "",
    "⚠️ INTEGRITY WARNING — This response claims tool execution that did not occur.",
    "No tool ran this turn: there is no tool result and no audit entry for it.",
    "Treat the tool-use claim above as unverified — it may be fabricated.",
  ].join("\n");
}
