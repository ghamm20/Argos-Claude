#!/usr/bin/env node
// Smoke test for H4 retrieval + truth-mode integration.
// Assumes:
//   - dev server on :3000
//   - Ollama daemon on 127.0.0.1:11434
//   - vault contains at least one ingested doc relevant to the probe
//
// Sends the same query twice (truthMode off, then on), asserts retrieval
// event present + content contains expected substrings, and prints both
// responses side-by-side for human review.

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const MODEL = process.env.SMOKE_MODEL || "llama3.1:8b-instruct-q4_K_M";
const PERSONA = process.env.SMOKE_PERSONA || "bartimaeus";
const QUERY = "What does USB-native rule 3 say about paths?";

async function runOnce({ truthMode }) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: QUERY }],
      personaId: PERSONA,
      model: MODEL,
      useRetrieval: true,
      truthMode,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(
      `HTTP ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let retrievalEvent = null;
  let ttft = null;
  let evalCount = 0;
  let evalDurationNs = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === "retrieval") {
        retrievalEvent = obj;
      } else if (obj.message?.content) {
        if (ttft === null) ttft = performance.now() - t0;
        text += obj.message.content;
      }
      if (obj.done) {
        evalCount = obj.eval_count ?? 0;
        evalDurationNs = obj.eval_duration ?? 0;
      }
    }
  }
  const total = performance.now() - t0;
  const tps = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;
  const citations = text.match(/\[\d+\]/g) ?? [];
  return {
    truthMode,
    ttftMs: ttft,
    totalMs: total,
    evalTokens: evalCount,
    tokensPerSec: tps,
    retrievalEvent,
    text,
    citations,
  };
}

function assert(label, cond, detail = "") {
  const tag = cond ? "✓" : "✗";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log(`PROBE                "${QUERY}"`);
  console.log(`MODEL                ${MODEL}`);
  console.log(`PERSONA              ${PERSONA}\n`);

  console.log("RUN 1 — truthMode: false");
  const run1 = await runOnce({ truthMode: false });
  console.log(`  TTFT          ${run1.ttftMs?.toFixed(0) ?? "—"} ms`);
  console.log(`  total         ${run1.totalMs.toFixed(0)} ms`);
  console.log(`  eval tokens   ${run1.evalTokens}`);
  console.log(`  tok/s         ${run1.tokensPerSec.toFixed(2)}`);
  console.log(
    `  retrieval     ${run1.retrievalEvent?.hits?.length ?? 0} hit(s), enabled=${run1.retrievalEvent?.enabled}`
  );
  console.log(`  citations     ${run1.citations.length} marker(s) ${run1.citations.join(" ")}`);

  console.log("\nASSERTIONS — run 1:");
  assert("retrieval event present", run1.retrievalEvent !== null);
  assert(
    "retrieval enabled in event",
    run1.retrievalEvent?.enabled === true
  );
  assert(
    "at least 1 hit returned",
    (run1.retrievalEvent?.hits?.length ?? 0) >= 1
  );
  const lowered1 = run1.text.toLowerCase();
  assert(
    'response mentions "relative" or "path"',
    lowered1.includes("relative") || lowered1.includes("path")
  );

  console.log("\nRUN 2 — truthMode: true");
  const run2 = await runOnce({ truthMode: true });
  console.log(`  TTFT          ${run2.ttftMs?.toFixed(0) ?? "—"} ms`);
  console.log(`  total         ${run2.totalMs.toFixed(0)} ms`);
  console.log(`  eval tokens   ${run2.evalTokens}`);
  console.log(`  tok/s         ${run2.tokensPerSec.toFixed(2)}`);
  console.log(
    `  retrieval     ${run2.retrievalEvent?.hits?.length ?? 0} hit(s), enabled=${run2.retrievalEvent?.enabled}`
  );
  console.log(`  citations     ${run2.citations.length} marker(s) ${run2.citations.join(" ")}`);

  // Heuristic check on style shift: truth-mode responses should be more
  // likely to contain hedging language or explicit source attribution.
  const HEDGE = [
    "the source",
    "based on",
    "according to",
    "suggests",
    "indicates",
    "i don't know",
    "uncertain",
    "appears to",
  ];
  const lowered2 = run2.text.toLowerCase();
  const hedgeCount1 = HEDGE.filter((h) => lowered1.includes(h)).length;
  const hedgeCount2 = HEDGE.filter((h) => lowered2.includes(h)).length;

  console.log("\nASSERTIONS — run 2 (truth mode):");
  assert("retrieval event present", run2.retrievalEvent !== null);
  assert(
    "retrieval enabled in event",
    run2.retrievalEvent?.enabled === true
  );
  assert(
    "at least 1 hit returned",
    (run2.retrievalEvent?.hits?.length ?? 0) >= 1
  );
  assert(
    'response mentions "relative" or "path"',
    lowered2.includes("relative") || lowered2.includes("path")
  );
  assert(
    "truth-mode shows >= as much hedging language as off-mode",
    hedgeCount2 >= hedgeCount1,
    `(off=${hedgeCount1} on=${hedgeCount2})`
  );

  console.log("\n┌─ RESPONSE — truthMode: false " + "─".repeat(36));
  console.log(run1.text);
  console.log("├─ RESPONSE — truthMode: true " + "─".repeat(37));
  console.log(run2.text);
  console.log("└" + "─".repeat(64));
}

main().catch((e) => {
  console.error("SMOKE_ERROR:", e);
  process.exit(1);
});
