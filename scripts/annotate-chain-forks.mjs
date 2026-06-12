#!/usr/bin/env node
// annotate-chain-forks.mjs — owner chain ruling (2026-06-12).
//
// Detects historical forks in an audit chain (consecutive sibling entries
// sharing index + prevHash — the concurrent-appendAudit race signature),
// content-verifies every entry, and appends ONE forward
// `chain.fork_annotated` entry documenting every not-yet-annotated fork.
// History is NEVER re-chained — the annotation extends the chain from the
// current tail like any other entry.
//
// Idempotent: forks already covered by an existing annotation are skipped;
// if nothing needs annotating the script writes nothing.
//
// Usage:
//   node scripts/annotate-chain-forks.mjs --chain D:\ARGOS\state\audit\chain.jsonl
//   node scripts/annotate-chain-forks.mjs --chain <path> --dry-run

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    const v = i + 1 < args.length && !args[i + 1].startsWith("--") ? args[++i] : true;
    argMap[k] = v;
  }
}
const chainPath = argMap.chain;
const dryRun = argMap["dry-run"] === true;
if (!chainPath || !existsSync(chainPath)) {
  console.error("usage: node scripts/annotate-chain-forks.mjs --chain <chain.jsonl> [--dry-run]");
  process.exit(2);
}

function canonicalJson(value) {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}
function computeEntryHash(rest) {
  return createHash("sha256").update(rest.prevHash).update(":").update(canonicalJson(rest)).digest("hex");
}

const entries = readFileSync(chainPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
console.log(`chain: ${chainPath} (${entries.length} entries)`);

// Content-verify EVERY entry first — the ruling only tolerates forks whose
// content is intact. Any tamper aborts: that is lockdown territory, not
// annotation territory.
for (let i = 0; i < entries.length; i++) {
  const { hash, ...rest } = entries[i];
  if (computeEntryHash(rest) !== hash) {
    console.error(`ABORT: content-hash mismatch at position ${i} (index ${entries[i].index}) — tampered entry; annotation refused`);
    process.exit(1);
  }
}
console.log("content verify: all entries PASS");

// Detect forks.
const forks = [];
for (let i = 1; i < entries.length; i++) {
  const a = entries[i - 1], b = entries[i];
  if (b.prevHash === a.prevHash && b.index === a.index) {
    const open = forks.find((f) => f.index === b.index && f.positions.includes(i - 1));
    if (open) {
      open.positions.push(i);
      open.branchHashes.push(b.hash);
      open.siblingKinds.push(b.kind);
    } else {
      forks.push({
        index: b.index,
        positions: [i - 1, i],
        branchHashes: [a.hash, b.hash],
        siblingKinds: [a.kind, b.kind],
        ts: a.ts,
      });
    }
  }
}
if (forks.length === 0) {
  console.log("no forks detected — nothing to annotate");
  process.exit(0);
}

// Drop forks already annotated.
const sameSet = (x, y) => x.length === y.length && [...x].sort().join("|") === [...y].sort().join("|");
const existing = [];
for (const e of entries) {
  if (e.kind !== "chain.fork_annotated") continue;
  for (const f of Array.isArray(e.payload?.forks) ? e.payload.forks : []) {
    if (typeof f?.index === "number" && Array.isArray(f?.branchHashes)) existing.push(f);
  }
}
const pending = forks.filter(
  (f) => !existing.some((a) => a.index === f.index && sameSet(a.branchHashes, f.branchHashes))
);
for (const f of forks) {
  console.log(
    `fork at index ${f.index} (positions ${f.positions.join("/")}, ${new Date(f.ts).toISOString()}, siblings: ${f.siblingKinds.join(" + ")}) — ${pending.includes(f) ? "PENDING annotation" : "already annotated"}`
  );
}
if (pending.length === 0) {
  console.log("all forks already annotated — nothing to do");
  process.exit(0);
}

const tail = entries[entries.length - 1];
const rest = {
  version: 1,
  index: tail.index + 1,
  ts: Date.now(),
  id: randomUUID().replace(/-/g, ""),
  kind: "chain.fork_annotated",
  payload: {
    ruling:
      "Owner chain ruling 2026-06-12: historical forks are documented forward; history is never re-chained. Annotated + content-verified forks verify GREEN-with-noted-forks; an unannotated break or content-hash mismatch stays a hard FAIL (lockdown-trigger class).",
    cause:
      "Concurrent appendAudit() writers in one server process raced the same chain tail (same-millisecond sibling pairs), duplicating index+prevHash. appendAudit is mutex-serialized as of this entry; post-fork index re-syncs (one skipped index value per fork) are bookkeeping holes, not deletions.",
    content_verified: true,
    forks: pending.map((f) => ({
      index: f.index,
      positions: f.positions,
      branchHashes: f.branchHashes,
      siblingKinds: f.siblingKinds,
      forkedAt: new Date(f.ts).toISOString(),
    })),
  },
  prevHash: tail.hash,
};
const entry = { ...rest, hash: computeEntryHash(rest) };
if (dryRun) {
  console.log("DRY RUN — would append:");
  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}
appendFileSync(chainPath, JSON.stringify(entry) + "\n", "utf8");
console.log(`appended chain.fork_annotated at index ${entry.index} (hash ${entry.hash.slice(0, 16)}…) documenting ${pending.length} fork(s)`);
