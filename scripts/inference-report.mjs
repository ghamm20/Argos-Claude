#!/usr/bin/env node
// inference-report.mjs (Stage 7, 2026-06-09) — weekly rollup of the
// chat.inference audit entries, the data Phase B (OpenAI/Claude providers) will
// be decided on. NO behavior change; read-only over the audit chain.
//
// Reads ARGOS_ROOT/state/audit/chain.jsonl (root from $ARGOS_ROOT or --root or
// cwd — never a hardcoded absolute path). Reports per-backend turn counts,
// p50/p95 latency, fallback rate, and failure-reason breakdown.
//
// Usage:
//   node scripts/inference-report.mjs                 (root = $ARGOS_ROOT or cwd)
//   node scripts/inference-report.mjs --root D:\ARGOS [--days 7]

import fs from "node:fs";
import path from "node:path";

const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg >= 0 ? process.argv[rootArg + 1] : (process.env.ARGOS_ROOT || process.cwd());
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) : 7;

const chainPath = path.join(ROOT, "state", "audit", "chain.jsonl");

let entries = [];
try {
  entries = fs.readFileSync(chainPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.kind === "chat.inference");
} catch (e) {
  console.error(`No audit chain at ${chainPath} (${e.message}). Set --root or $ARGOS_ROOT to a live payload.`);
  process.exit(0);
}

if (entries.length === 0) {
  console.log(`inference-report: 0 chat.inference entries at ${chainPath}.`);
  console.log("(No inference turns recorded in this root yet — point --root at a live payload, e.g. D:\\ARGOS.)");
  process.exit(0);
}

// Optional N-day window (by entry.ts epoch ms). If nothing in-window, fall back
// to ALL with a note (honest — don't show an empty table).
const nowMs = Math.max(...entries.map((e) => e.ts || 0));
const windowStart = nowMs - DAYS * 24 * 3600 * 1000;
let scoped = entries.filter((e) => (e.ts || 0) >= windowStart);
let windowNote = `last ${DAYS}d`;
if (scoped.length === 0) { scoped = entries; windowNote = "all-time (no entries in window)"; }

const p = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const pay = (e) => e.payload || {};

const byBackend = {};
const fallbackReasons = {};
let fallbacks = 0;
for (const e of scoped) {
  const d = pay(e);
  const b = d.backend || "unknown";
  (byBackend[b] ??= { count: 0, lat: [], promptTok: 0, complTok: 0 }).count++;
  if (typeof d.latency_ms === "number") byBackend[b].lat.push(d.latency_ms);
  if (typeof d.prompt_tokens === "number") byBackend[b].promptTok += d.prompt_tokens;
  if (typeof d.completion_tokens === "number") byBackend[b].complTok += d.completion_tokens;
  if (d.fallback_reason) { fallbacks++; fallbackReasons[d.fallback_reason] = (fallbackReasons[d.fallback_reason] || 0) + 1; }
}

const dates = scoped.map((e) => e.ts).filter(Boolean).sort((a, b) => a - b);
const range = dates.length ? `${new Date(dates[0]).toISOString().slice(0, 10)} → ${new Date(dates[dates.length - 1]).toISOString().slice(0, 10)}` : "n/a";

console.log(`\n=== ARGOS inference rollup (${windowNote}) ===`);
console.log(`root:   ${ROOT}`);
console.log(`window: ${range}   turns: ${scoped.length}`);
console.log("");
console.log("backend".padEnd(10) + "turns".padStart(7) + "share".padStart(8) + "p50 ms".padStart(9) + "p95 ms".padStart(9) + "tok in".padStart(9) + "tok out".padStart(9));
console.log("-".repeat(61));
for (const [b, v] of Object.entries(byBackend).sort((a, c) => c[1].count - a[1].count)) {
  const share = ((v.count / scoped.length) * 100).toFixed(0) + "%";
  console.log(
    b.padEnd(10) +
    String(v.count).padStart(7) +
    share.padStart(8) +
    String(p(v.lat, 0.5) ?? "—").padStart(9) +
    String(p(v.lat, 0.95) ?? "—").padStart(9) +
    String(v.promptTok).padStart(9) +
    String(v.complTok).padStart(9)
  );
}
console.log("");
console.log(`fallback rate: ${((fallbacks / scoped.length) * 100).toFixed(1)}%  (${fallbacks}/${scoped.length})`);
if (Object.keys(fallbackReasons).length) {
  console.log("fallback reasons:");
  for (const [r, n] of Object.entries(fallbackReasons).sort((a, c) => c[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);
} else {
  console.log("fallback reasons: none");
}
console.log("\n(Phase B decision data — providers NOT wired; this is measurement only.)");
