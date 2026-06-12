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

// Fork tolerance (owner chain ruling, 2026-06-12 — MUST match lib/audit.ts
// verifyChain): a fork = consecutive sibling entries sharing index+prevHash
// (concurrent-writer race). Content-hash mismatch anywhere = hard FAIL.
// A fork documented by a later chain.fork_annotated entry (matching index +
// full branch-hash set) is tolerated → GREEN_WITH_NOTED_FORKS. An
// unannotated fork stays a hard FAIL (lockdown-trigger class). Post-fork
// index re-sync (entry.index == file position) is tolerated when the
// prevHash linkage is intact.
function verifyChainFile(filePath) {
  if (!existsSync(filePath)) {
    console.log(`  [ok ] chain file does not exist — empty/genesis case (0 entries)`);
    return { ok: true, totalEntries: 0, status: "GREEN" };
  }
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch (e) {
      console.log(`  [FAIL] line ${i + 1}: malformed JSON — ${e.message}`);
      return { ok: false, brokenAtIndex: i, brokenReason: "malformed JSON" };
    }
  }
  if (entries.length === 0) {
    console.log(`  [ok ] 0 entries — empty chain`);
    return { ok: true, totalEntries: 0, status: "GREEN" };
  }

  // Pass 1 — content integrity (tamper anywhere = hard FAIL).
  for (let i = 0; i < entries.length; i++) {
    const { hash: stored, ...rest } = entries[i];
    const recomputed = computeEntryHash(rest);
    if (recomputed !== stored) {
      console.log(`  [FAIL] position ${i} (index ${entries[i].index}): hash mismatch — payload tampered`);
      console.log(`         stored:     ${stored}`);
      console.log(`         recomputed: ${recomputed}`);
      return { ok: false, brokenAtIndex: i, brokenReason: "hash mismatch (tamper)" };
    }
  }

  // Fork annotations.
  const annotated = [];
  for (const e of entries) {
    if (e.kind !== "chain.fork_annotated") continue;
    for (const f of Array.isArray(e.payload?.forks) ? e.payload.forks : []) {
      if (typeof f?.index === "number" && Array.isArray(f?.branchHashes)) {
        annotated.push({ index: f.index, branchHashes: f.branchHashes });
      }
    }
  }
  const sameSet = (a, b) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

  // Pass 2 — linkage with fork tolerance.
  if (entries[0].prevHash !== "" || entries[0].index !== 0) {
    console.log(`  [FAIL] genesis entry must have index 0 and empty prevHash`);
    return { ok: false, brokenAtIndex: 0, brokenReason: "bad genesis" };
  }
  const forks = [];
  let tips = new Set([entries[0].hash]);
  let prev = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash === prev.prevHash && e.index === prev.index) {
      const open = forks.find((f) => f.index === e.index && f.positions.includes(i - 1));
      if (open) {
        open.positions.push(i);
        open.branchHashes.push(e.hash);
      } else {
        forks.push({ index: e.index, positions: [i - 1, i], branchHashes: [prev.hash, e.hash] });
      }
      tips.add(e.hash);
      prev = e;
      continue;
    }
    if (tips.has(e.prevHash) && (e.index === prev.index + 1 || e.index === i)) {
      tips = new Set([e.hash]);
      prev = e;
      continue;
    }
    console.log(
      `  [FAIL] position ${i} (index ${e.index}): prevHash mismatch (expected one of [${[...tips].map((h) => h.slice(0, 12)).join(", ")}], got ${(e.prevHash || "<empty>").slice(0, 12)})`
    );
    return { ok: false, brokenAtIndex: i, brokenReason: "prevHash mismatch" };
  }

  // Pass 3 — every fork must be annotated.
  for (const f of forks) {
    const isAnnotated = annotated.some((a) => a.index === f.index && sameSet(a.branchHashes, f.branchHashes));
    if (!isAnnotated) {
      console.log(
        `  [FAIL] UNANNOTATED chain fork at index ${f.index} (positions ${f.positions.join("/")}) — lockdown-trigger class`
      );
      return { ok: false, brokenAtIndex: f.index, brokenReason: "unannotated fork" };
    }
    console.log(`  [fork] index ${f.index} (positions ${f.positions.join("/")}) — annotated, content-verified, tolerated`);
  }

  const status = forks.length > 0 ? "GREEN_WITH_NOTED_FORKS" : "GREEN";
  console.log(
    `  [ok ] ${entries.length} entries verified — ${status === "GREEN" ? "chain intact" : `chain intact with ${forks.length} noted fork(s)`}, last hash ${prev.hash.slice(0, 16)}…`
  );
  return { ok: true, totalEntries: entries.length, lastHash: prev.hash, status, forks };
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
  console.log(
    chainResult.status === "GREEN_WITH_NOTED_FORKS"
      ? `VERIFY: PASS (GREEN with ${chainResult.forks.length} noted fork(s))`
      : "VERIFY: PASS"
  );
  process.exit(0);
} else {
  console.log("VERIFY: FAIL");
  process.exit(1);
}
