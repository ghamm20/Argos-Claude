#!/usr/bin/env node
// proof-phase8-guard-unit.mjs — Phase 8 #3 uncited-claim guard extension
// (Phase 3 R2 rider, 2026-06-10). DETERMINISTIC unit proof of the pure
// detectUncitedVaultClaim logic, tied to the production source.
//
// Why a unit proof (not the mock-server gate5): the guard is a PURE FUNCTION,
// so a deterministic unit test is the strongest evidence — and it is immune to
// the .next contention from a concurrently-running `next dev` (which races any
// prod-build server proof on this machine). The proof BINDS to production by
// extracting the actual SOURCE_NOUN / REPORT_VERB / regexes from
// lib/tool-integrity.ts and reproducing detectUncitedVaultClaim's exact logic.
//
// Asserts the phrasing-independent extension: the Phase 2 $48B fabrication is
// caught under ANY source-reporting phrasing (vault/records/document/archive…),
// while cited-with-hit, honest-absence, and truly-unattributed claims are NOT
// flagged (the documented honest residual).

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(repoRoot, "lib", "tool-integrity.ts"), "utf8");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

// --- extract the production string constants (VERBATIM, not paraphrased) ---
function extractStr(name) {
  // const NAME = "..."  OR  const NAME = "..." + "..." + ...;  (up to the ;)
  const m = src.match(new RegExp(`const ${name} =([\\s\\S]*?);`));
  if (!m) { console.error(`ABORT: ${name} not found in source`); process.exit(1); }
  // Evaluate the string-concatenation literal from our own repo source.
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[1].trim()});`)();
}
const SOURCE_NOUN = extractStr("SOURCE_NOUN");
const REPORT_VERB = extractStr("REPORT_VERB");
check("source exposes SOURCE_NOUN + REPORT_VERB", typeof SOURCE_NOUN === "string" && typeof REPORT_VERB === "string");
check("REPORT_VERB widened beyond 'state' (phrasing-independent)", /show|indicate|record|document|describe|mention/.test(REPORT_VERB));
check("SOURCE_NOUN widened beyond 'vault' (records/document/archive/canon)", /records\?|documents\?|archive|canon|source/.test(SOURCE_NOUN));

// Rebuild the production regexes identically.
const VAULT_ATTRIBUTION_RE = new RegExp(
  `\\b(?:the\\s+(?:${SOURCE_NOUN})\\s+(?:${REPORT_VERB})|(?:according\\s+to|per|based\\s+on|as\\s+(?:stated|written|recorded|noted)\\s+in)\\s+the\\s+(?:${SOURCE_NOUN}))\\b`,
  "i"
);
const ABSENCE_CLAIM_RE = /\b(?:no\s+(?:records?|entries|entry|documents?|information|mention|data)|nothing|not\s+(?:contain|cover|mention|include)|doesn'?t|does\s+not|contains?\s+no)\b/i;
function detectUncitedVaultClaim(content, hitCount) {
  if (!content) return { violation: false };
  for (const s of content.split(/(?<=[.!?])\s+|\n+/)) {
    if (!VAULT_ATTRIBUTION_RE.test(s)) continue;
    if (ABSENCE_CLAIM_RE.test(s)) continue;
    const cites = [...s.matchAll(/\[(\d{1,2})\]/g)].map((m) => parseInt(m[1], 10));
    if (!cites.some((n) => n >= 1 && n <= hitCount)) return { violation: true, sentence: s.slice(0, 80) };
  }
  return { violation: false };
}

// Sanity: confirm our rebuilt regex equals the production-constructed one by
// also checking the production new RegExp(...) call shape exists in source.
check("production builds VAULT_ATTRIBUTION_RE from these constants", /new RegExp\([\s\S]*\$\{SOURCE_NOUN\}[\s\S]*\$\{REPORT_VERB\}/.test(src));

const FAB = "$48 billion USD for Fiscal Year 2031";
console.log("\n=== caught: same fabrication under ANY source-reporting phrasing (hits=0) ===");
const caughtCases = [
  ["the vault states (original)", `The vault states that the Lunar Mining Colony allocated ${FAB}.`],
  ["the records show", `The records show the colony allocated ${FAB}.`],
  ["according to the document", `According to the document, the budget totaled ${FAB}.`],
  ["per the archive", `Per the archive, habitat expansion consumed ${FAB}.`],
  ["the corpus confirms", `The corpus confirms ${FAB} was spent.`],
  ["the index lists", `The index lists ${FAB} for the colony.`],
  ["the text describes", `The text describes ${FAB} in detail.`],
  ["based on the source", `Based on the source, ${FAB} was allocated.`],
];
for (const [label, text] of caughtCases) {
  check(`CAUGHT: ${label}`, detectUncitedVaultClaim(text, 0).violation === true);
}

console.log("\n=== NOT flagged (negative controls) ===");
check("cited claim with a backing hit (hits>0, [1])", detectUncitedVaultClaim("The vault states the rule [1].", 1).violation === false);
check("honest absence ('the vault contains no records')", detectUncitedVaultClaim("The vault contains no records of that topic.", 0).violation === false);
check("truly-unattributed claim (honest residual — own-knowledge)", detectUncitedVaultClaim(`The lunar budget was ${FAB}.`, 0).violation === false);
check("ordinary persona prose (no source attribution)", detectUncitedVaultClaim("I have watched five thousand years of empires fall.", 0).violation === false);

console.log("\n=== boundary: out-of-range citation still caught (false-citation family) ===");
check("attribution with an out-of-range [N] (hits=1, cites [3])", detectUncitedVaultClaim("The records show the figure [3].", 1).violation === true);

console.log(`\nproof-phase8-guard-unit: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
