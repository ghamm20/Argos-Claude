#!/usr/bin/env node
// verify-audit-chain.mjs — standalone hash-chain verifier.
//
// Walks $ARGOS_ROOT/state/audit/chain.jsonl from genesis. For each entry:
//   - check entry.index matches file position
//   - check entry.prevHash matches previous entry.hash (or "" for genesis)
//   - recompute entry.hash = sha256(prevHash + ":" + canonicalJson(entryWithoutHash))
//     and verify it matches stored hash
//
// Any mismatch = tamper detected. Exits 0 if chain is intact, 1 otherwise.
//
// Usage:
//   node scripts/verify-audit-chain.mjs              # use $ARGOS_ROOT
//   node scripts/verify-audit-chain.mjs --chain PATH # explicit chain file
//   node scripts/verify-audit-chain.mjs --bundle PATH # verify a session-export
//                                                      JSON bundle in addition

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    const v = (i + 1 < args.length && !args[i + 1].startsWith("--")) ? args[++i] : true;
    argMap[k] = v;
  }
}

const argosRoot =
  argMap.root ?? process.env.ARGOS_ROOT ?? process.cwd();
const chainPath =
  argMap.chain ?? join(argosRoot, "state", "audit", "chain.jsonl");

console.log(`verify-audit-chain`);
console.log(`  chain: ${chainPath}`);

// Canonical JSON — sorted keys at every nesting level. MUST match lib/audit.ts.
// CRITICAL: drop undefined-valued keys (matches JSON.stringify semantics)
// so hashes round-trip cleanly through file persistence.
function canonicalJson(value) {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return (
      "[" +
      value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") +
      "]"
    );
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]));
  return "{" + parts.join(",") + "}";
}

function computeEntryHash(entryWithoutHash) {
  return createHash("sha256")
    .update(entryWithoutHash.prevHash)
    .update(":")
    .update(canonicalJson(entryWithoutHash))
    .digest("hex");
}

function verifyChainFile(filePath) {
  if (!existsSync(filePath)) {
    console.log(`  [ok ] chain file does not exist — empty/genesis case (0 entries)`);
    return { ok: true, totalEntries: 0 };
  }
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let prevHash = "";
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch (e) {
      console.log(`  [FAIL] line ${i + 1}: malformed JSON — ${e.message}`);
      return { ok: false, brokenAtIndex: i, brokenReason: "malformed JSON" };
    }
    if (entry.index !== i) {
      console.log(`  [FAIL] index ${i}: entry.index = ${entry.index}`);
      return { ok: false, brokenAtIndex: i, brokenReason: "index mismatch" };
    }
    if (entry.prevHash !== prevHash) {
      console.log(
        `  [FAIL] index ${i}: prevHash mismatch (expected ${
          prevHash || "<genesis>"
        }, got ${entry.prevHash || "<empty>"})`
      );
      return { ok: false, brokenAtIndex: i, brokenReason: "prevHash mismatch" };
    }
    const { hash: stored, ...rest } = entry;
    const recomputed = computeEntryHash(rest);
    if (recomputed !== stored) {
      console.log(
        `  [FAIL] index ${i}: hash mismatch — payload tampered`
      );
      console.log(`         stored:     ${stored}`);
      console.log(`         recomputed: ${recomputed}`);
      return { ok: false, brokenAtIndex: i, brokenReason: "hash mismatch (tamper)" };
    }
    prevHash = stored;
  }
  console.log(
    `  [ok ] ${lines.length} entries verified — chain intact, last hash ${prevHash.slice(
      0,
      16
    )}…`
  );
  return { ok: true, totalEntries: lines.length, lastHash: prevHash };
}

function verifyBundle(bundlePath) {
  console.log(`  bundle: ${bundlePath}`);
  if (!existsSync(bundlePath)) {
    console.log(`  [FAIL] bundle file missing`);
    return { ok: false };
  }
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  const { bundleHash: stored, ...rest } = bundle;
  const recomputed = createHash("sha256").update(canonicalJson(rest)).digest("hex");
  if (recomputed !== stored) {
    console.log(`  [FAIL] bundle hash mismatch — bundle tampered`);
    console.log(`         stored:     ${stored}`);
    console.log(`         recomputed: ${recomputed}`);
    return { ok: false, reason: "bundle hash mismatch" };
  }
  console.log(`  [ok ] bundle hash matches`);
  // Optionally also verify the audit array's internal chain links.
  const audit = bundle.audit ?? [];
  if (audit.length > 0) {
    let prevHash = audit[0].prevHash;
    for (let i = 0; i < audit.length; i++) {
      const e = audit[i];
      // entries in a session-scoped bundle may have non-contiguous indices
      // (other sessions' entries are interleaved in the full chain). We
      // only verify each entry's OWN hash here, not chain continuity.
      const { hash: stored2, ...rest2 } = e;
      const recomputed2 = computeEntryHash(rest2);
      if (recomputed2 !== stored2) {
        console.log(
          `  [FAIL] bundle audit[${i}]: hash mismatch — entry tampered`
        );
        return { ok: false, reason: `audit entry ${i} hash mismatch` };
      }
    }
    console.log(`  [ok ] ${audit.length} audit entries' hashes verified individually`);
  }
  return { ok: true };
}

console.log("");
const chainResult = verifyChainFile(chainPath);

let bundleResult = { ok: true };
if (argMap.bundle) {
  console.log("");
  bundleResult = verifyBundle(resolve(argMap.bundle));
}

console.log("");
const allOk = chainResult.ok && bundleResult.ok;
if (allOk) {
  console.log("VERIFY: PASS");
  process.exit(0);
} else {
  console.log("VERIFY: FAIL");
  process.exit(1);
}
