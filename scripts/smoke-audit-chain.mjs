#!/usr/bin/env node
// smoke-audit-chain.mjs — verifies the audit-chain machinery end-to-end.
//
// Approach: build a synthetic chain.jsonl using the same canonical-JSON
// + sha256 algorithm as lib/audit.ts, run verify-audit-chain.mjs against
// it (expects PASS), tamper one byte in the middle, re-verify (expects
// FAIL with a clear reason).
//
// Uses a tmpdir; never touches the real ARGOS chain.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const verifyScript = resolve(__dir, "verify-audit-chain.mjs");

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

function buildChain(events) {
  const entries = [];
  let prevHash = "";
  let index = 0;
  for (const e of events) {
    const rest = {
      version: 1,
      index,
      ts: 1700000000000 + index * 1000,
      id: randomUUID().replace(/-/g, ""),
      kind: e.kind,
      sessionId: e.sessionId,
      payload: e.payload,
      prevHash,
    };
    const hash = computeEntryHash(rest);
    entries.push({ ...rest, hash });
    prevHash = hash;
    index++;
  }
  return entries;
}

function runVerify(chainPath, label) {
  const r = spawnSync(process.execPath, [verifyScript, "--chain", chainPath], {
    encoding: "utf8",
  });
  return { exitCode: r.status, stdout: r.stdout, label };
}

let totalFail = 0;
function check(label, cond, detail = "") {
  const tag = cond ? "[ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) totalFail++;
}

const dir = mkdtempSync(join(tmpdir(), "audit-smoke-"));
const chainPath = join(dir, "chain.jsonl");
console.log(`smoke-audit-chain  tmpdir: ${dir}`);
console.log("");

try {
  // ---- Test 1: build clean chain, expect PASS ----
  console.log("=== Test 1: clean 5-entry chain ===");
  const chain = buildChain([
    { kind: "session.created", sessionId: "s1", payload: { title: "First session" } },
    { kind: "vault.ingested", payload: { docId: "abc", filename: "test.md", chunkCount: 3 } },
    { kind: "session.updated", sessionId: "s1", payload: { messageCount: 4 } },
    { kind: "settings.changed", payload: { changed: ["defaultPersona"], defaultPersona: "sage" } },
    { kind: "session.updated", sessionId: "s1", payload: { messageCount: 6 } },
  ]);
  writeFileSync(chainPath, chain.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r1 = runVerify(chainPath, "clean");
  check("clean chain verifies PASS (exit 0)", r1.exitCode === 0);
  check("clean chain reports 5 entries", /5 entries verified/.test(r1.stdout));

  // ---- Test 2: tamper one byte in middle entry's payload ----
  console.log("");
  console.log("=== Test 2: tamper payload of entry index 2 ===");
  const lines = readFileSync(chainPath, "utf8").split("\n").filter((l) => l.length > 0);
  // Tamper the 3rd entry (index 2) by changing messageCount 4 → 9999
  lines[2] = lines[2].replace('"messageCount":4', '"messageCount":9999');
  writeFileSync(chainPath, lines.join("\n") + "\n");
  const r2 = runVerify(chainPath, "tamper-payload");
  check("tampered chain verifies FAIL (exit 1)", r2.exitCode === 1);
  check("tampered chain reports hash mismatch", /hash mismatch/.test(r2.stdout));
  check("tampered chain identifies index 2 as the break", /index 2:/.test(r2.stdout));

  // ---- Test 3: rebuild clean, tamper prevHash this time ----
  console.log("");
  console.log("=== Test 3: tamper prevHash of entry index 3 ===");
  writeFileSync(chainPath, chain.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const lines3 = readFileSync(chainPath, "utf8").split("\n").filter((l) => l.length > 0);
  const e3 = JSON.parse(lines3[3]);
  e3.prevHash = "0".repeat(64);  // bogus hash
  lines3[3] = JSON.stringify(e3);
  writeFileSync(chainPath, lines3.join("\n") + "\n");
  const r3 = runVerify(chainPath, "tamper-prevHash");
  check("tampered prevHash verifies FAIL (exit 1)", r3.exitCode === 1);
  // It could either flag prevHash mismatch OR hash mismatch (since the entry's
  // own hash was computed with the original prevHash). Either is a valid catch.
  check(
    "tampered prevHash flags some mismatch at index 3",
    /index 3:/.test(r3.stdout) && /(prevHash mismatch|hash mismatch)/.test(r3.stdout)
  );

  // ---- Test 4: delete a middle entry ----
  console.log("");
  console.log("=== Test 4: delete entry index 2 (chain skips an index) ===");
  writeFileSync(chainPath, chain.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const lines4 = readFileSync(chainPath, "utf8").split("\n").filter((l) => l.length > 0);
  lines4.splice(2, 1);  // drop index 2
  writeFileSync(chainPath, lines4.join("\n") + "\n");
  const r4 = runVerify(chainPath, "delete-entry");
  check("deleted-middle-entry verifies FAIL (exit 1)", r4.exitCode === 1);
  check(
    "deleted-middle-entry flags break at index 2 or 3",
    /(index 2|index 3)/.test(r4.stdout)
  );

  // ---- Test 5: empty chain (genesis only) ----
  console.log("");
  console.log("=== Test 5: empty chain file ===");
  writeFileSync(chainPath, "");
  const r5 = runVerify(chainPath, "empty");
  check("empty chain verifies PASS (exit 0)", r5.exitCode === 0);
  check("empty chain reports 0 entries", /0 entries|chain file does not exist/.test(r5.stdout));

} finally {
  // Clean up
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
console.log(
  totalFail === 0
    ? "smoke-audit-chain: PASS"
    : `smoke-audit-chain: ${totalFail} FAIL${totalFail === 1 ? "" : "S"}`
);
process.exit(totalFail === 0 ? 0 : 1);
