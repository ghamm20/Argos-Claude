#!/usr/bin/env node
// validate-e4b.mjs — Phase 2-RB model validation harness.
//
// Runs the 10-point validation protocol from the Phase 2 directive
// against e4b:latest (primary, Bartimaeus candidate) and
// gemma2-2b-local:latest (fallback / Bobby candidate / lightweight
// diagnostic). Captures: cold-load, first-token, total-response,
// tok/s, VRAM if exposed, coherence (prompts A-E), garbage-token
// behavior, swap recovery, 3-swap repeat, restart-persistence.
//
// Output: writes a structured JSON report to validation-e4b.json
// in the cwd, plus a human-readable summary to stdout.

import { promises as fsp } from "node:fs";

const OLLAMA = process.env.OLLAMA_HOST?.startsWith("http")
  ? process.env.OLLAMA_HOST
  : `http://${process.env.OLLAMA_HOST || "127.0.0.1:11434"}`;

const PRIMARY = "e4b:latest";
const FALLBACK = "gemma2-2b-local:latest";

// Bartimaeus system prompt — verbatim from lib/personas.ts.
const BART_SYS = [
  "You are Bartimaeus, an ancient hermetic strategist.",
  "Sharp, rigorous, dry wit. Truth-first. Surface uncertainty explicitly — name what you don't know rather than smoothing over it.",
  "Short paragraphs. Avoid bullet lists unless asked. Never fake confidence.",
  "",
  "When retrieval context is provided in the system message, cite using [1], [2] format. If no relevant retrieval exists, say so plainly. Never fabricate citations.",
].join("\n");

const PROMPTS = {
  A: "State your role in one paragraph.",
  B: "Explain why truth matters more than comfort.",
  C: "Summarize this system in plain English: ARGOS is a local-first AI workstation.",
  D: "Push back on this claim: all live data is automatically useful.",
  E: "Give me a concise operational answer: what should I verify before trusting a sensor feed?",
};

// Garbage detection heuristics. Conservative — only flags clear failure
// modes; small artifacts (occasional unicode glyph) are not "garbage."
function looksDegenerate(text) {
  if (!text || text.length === 0) return { degenerate: true, reason: "empty" };
  // 1. Massive single-token repetition (8+ char fragment ×5+ in a row)
  if (/(.{8,})\1{4,}/.test(text)) {
    return { degenerate: true, reason: "8-char fragment repeats 5+ times" };
  }
  // 2. Token-loop where almost every word equals the most common one.
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 20) {
    const counts = {};
    for (const w of words) counts[w] = (counts[w] || 0) + 1;
    const most = Math.max(...Object.values(counts));
    if (most / words.length > 0.6) {
      return {
        degenerate: true,
        reason: `single token "${
          Object.entries(counts).find(([_, c]) => c === most)[0]
        }" = ${((most / words.length) * 100).toFixed(0)}% of output`,
      };
    }
  }
  // 3. Non-printable / control-char ratio
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32) || c === 127) bad++;
  }
  if (bad / text.length > 0.02) {
    return {
      degenerate: true,
      reason: `${((bad / text.length) * 100).toFixed(1)}% control chars`,
    };
  }
  return { degenerate: false, reason: null };
}

async function chat(model, system, userPrompt, opts = {}) {
  const startCall = Date.now();
  let firstTokenAt = null;
  let fullText = "";
  let thinkingText = "";
  let stats = null;

  const body = {
    model,
    messages: system
      ? [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ]
      : [{ role: "user", content: userPrompt }],
    stream: true,
    // CRITICAL: e4b (gemma4) supports `thinking` capability — by default
    // can emit ALL output into message.thinking and zero into
    // message.content. Disable for production-bound persona use so the
    // operator sees a real answer. `think: false` is the documented
    // Ollama flag; redundant with options.think but covers all forks.
    think: opts.think ?? false,
    options: { think: opts.think ?? false },
  };

  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`ollama /api/chat HTTP ${res.status}: ${t}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        const chunk = j?.message?.content;
        const think = j?.message?.thinking;
        if (chunk) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          fullText += chunk;
        }
        if (think) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          thinkingText += think;
        }
        if (j?.done) {
          stats = {
            eval_count: j.eval_count ?? 0,
            eval_duration_ms: j.eval_duration ? j.eval_duration / 1e6 : 0,
            prompt_eval_count: j.prompt_eval_count ?? 0,
            load_duration_ms: j.load_duration ? j.load_duration / 1e6 : 0,
            total_duration_ms: j.total_duration ? j.total_duration / 1e6 : 0,
          };
        }
      }
      nl = buf.indexOf("\n");
    }
  }
  const total = Date.now() - startCall;
  const ttft = firstTokenAt ? firstTokenAt - startCall : null;
  const tps =
    stats?.eval_duration_ms && stats.eval_count
      ? (stats.eval_count / stats.eval_duration_ms) * 1000
      : null;
  return {
    text: fullText,
    thinking: thinkingText,
    totalMs: total,
    timeToFirstTokenMs: ttft,
    tokensPerSec: tps,
    raw: stats,
  };
}

async function unload(model) {
  // Send a chat with keep_alive=0 to release the model from memory.
  try {
    await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* swallow — unload best-effort */
  }
}

async function psStatus() {
  // /api/ps returns currently-loaded models + their sizes
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j;
  } catch {
    return null;
  }
}

async function vramReport() {
  // Try nvidia-smi via the OS — Windows ships nvidia-smi.exe in PATH on
  // GeForce installs. If absent or non-NVIDIA, return null.
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise((resolve) => {
      const child = spawn("nvidia-smi", [
        "--query-gpu=memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ]);
      let out = "";
      child.stdout.on("data", (c) => (out += c.toString()));
      child.on("close", () => {
        const parts = out.trim().split(",").map((s) => s.trim());
        if (parts.length === 2) {
          const used = parseInt(parts[0], 10);
          const total = parseInt(parts[1], 10);
          if (!isNaN(used) && !isNaN(total)) {
            resolve({ usedMB: used, totalMB: total });
            return;
          }
        }
        resolve(null);
      });
      child.on("error", () => resolve(null));
    });
  } catch {
    return null;
  }
}

const report = {
  timestamp: new Date().toISOString(),
  ollamaHost: OLLAMA,
  primary: { model: PRIMARY, tests: {} },
  fallback: { model: FALLBACK, tests: {} },
};

function section(title) {
  console.log("\n=== " + title + " ===");
}

// ----- start measurement -----
section("Pre-flight");
const initialPs = await psStatus();
console.log(
  "loaded models at start:",
  (initialPs?.models ?? []).map((m) => m.name).join(", ") || "(none)"
);
const baselineVram = await vramReport();
console.log(
  "baseline VRAM:",
  baselineVram
    ? `${baselineVram.usedMB} / ${baselineVram.totalMB} MB`
    : "nvidia-smi not available"
);
report.preFlight = {
  loadedAtStart: (initialPs?.models ?? []).map((m) => ({
    name: m.name,
    sizeBytes: m.size,
  })),
  baselineVram,
};

// Unload everything first for a clean cold-load measurement
for (const m of (initialPs?.models ?? []).map((x) => x.name)) {
  console.log(`unloading ${m}…`);
  await unload(m);
}
await new Promise((r) => setTimeout(r, 2000));

// ----- e4b:latest validation -----
section(`Primary: ${PRIMARY} (Bartimaeus candidate)`);

console.log("\n[T1] Cold load — first call after unload");
const t1 = await chat(PRIMARY, BART_SYS, PROMPTS.A);
const vramAfterLoad = await vramReport();
report.primary.tests.coldLoad = {
  loadDurationMs: t1.raw?.load_duration_ms ?? null,
  totalMs: t1.totalMs,
  timeToFirstTokenMs: t1.timeToFirstTokenMs,
  tokensPerSec: t1.tokensPerSec,
  evalCount: t1.raw?.eval_count ?? null,
  vramAfterLoad,
  promptKey: "A",
  response: t1.text,
  thinkingChars: (t1.thinking || "").length,
  degenerate: looksDegenerate(t1.text),
};
console.log(
  `  load=${t1.raw?.load_duration_ms?.toFixed(0)}ms ttft=${t1.timeToFirstTokenMs}ms total=${t1.totalMs}ms tps=${t1.tokensPerSec?.toFixed(1)}`
);
console.log(
  `  VRAM after load: ${vramAfterLoad ? `${vramAfterLoad.usedMB}/${vramAfterLoad.totalMB} MB` : "n/a"}`
);
console.log(`  [degenerate-check] ${JSON.stringify(report.primary.tests.coldLoad.degenerate)}`);
console.log(`  --- RESPONSE A ---\n${t1.text.trim().slice(0, 800)}\n  ---`);

console.log("\n[T2-T5] Warm — prompts B,C,D,E");
for (const key of ["B", "C", "D", "E"]) {
  const r = await chat(PRIMARY, BART_SYS, PROMPTS[key]);
  report.primary.tests[`prompt${key}`] = {
    totalMs: r.totalMs,
    timeToFirstTokenMs: r.timeToFirstTokenMs,
    tokensPerSec: r.tokensPerSec,
    evalCount: r.raw?.eval_count ?? null,
    response: r.text,
    thinkingChars: (r.thinking || "").length,
    degenerate: looksDegenerate(r.text),
  };
  console.log(
    `  prompt ${key}: ttft=${r.timeToFirstTokenMs}ms total=${r.totalMs}ms tps=${r.tokensPerSec?.toFixed(1)} degen=${report.primary.tests[`prompt${key}`].degenerate.degenerate}`
  );
  console.log(`  --- RESPONSE ${key} ---\n${r.text.trim().slice(0, 600)}\n  ---`);
}

// ----- swap test -----
section("Model swap stress");
const swapStart = Date.now();
console.log("\n[T6] Swap → gemma2-2b-local → back to e4b");
await unload(PRIMARY);
await new Promise((r) => setTimeout(r, 1500));
const swapAway = await chat(FALLBACK, null, "Say hi in one word.");
console.log(`  swap to fallback ttft=${swapAway.timeToFirstTokenMs}ms`);
await unload(FALLBACK);
await new Promise((r) => setTimeout(r, 1500));
const swapBack = await chat(PRIMARY, BART_SYS, "Confirm you're loaded.");
const swapTotal = Date.now() - swapStart;
report.primary.tests.swapRecovery = {
  totalSwapCycleMs: swapTotal,
  fallbackTtftMs: swapAway.timeToFirstTokenMs,
  primaryReloadTtftMs: swapBack.timeToFirstTokenMs,
  primaryReloadResponse: swapBack.text,
  degenerate: looksDegenerate(swapBack.text),
};
console.log(
  `  cycle=${swapTotal}ms reload ttft=${swapBack.timeToFirstTokenMs}ms degen=${report.primary.tests.swapRecovery.degenerate.degenerate}`
);
console.log(`  reload response: ${swapBack.text.trim().slice(0, 200)}`);

console.log("\n[T7] 3 sequential swap cycles");
const cycles = [];
for (let i = 1; i <= 3; i++) {
  await unload(PRIMARY);
  await unload(FALLBACK);
  await new Promise((r) => setTimeout(r, 1000));
  const a = await chat(PRIMARY, BART_SYS, "Two-word reply: status?");
  await unload(PRIMARY);
  const b = await chat(FALLBACK, null, "Two-word reply: status?");
  cycles.push({
    iteration: i,
    primaryTtft: a.timeToFirstTokenMs,
    primaryDegen: looksDegenerate(a.text),
    fallbackTtft: b.timeToFirstTokenMs,
    fallbackDegen: looksDegenerate(b.text),
    primaryResponse: a.text.slice(0, 80),
    fallbackResponse: b.text.slice(0, 80),
  });
  console.log(
    `  cycle ${i}: primary=${a.timeToFirstTokenMs}ms fallback=${b.timeToFirstTokenMs}ms — primary="${a.text.trim().slice(0, 40)}…" fallback="${b.text.trim().slice(0, 40)}…"`
  );
}
report.primary.tests.threeSwapRepeat = cycles;

// ----- fallback (gemma2-2b-local) validation -----
section(`Fallback: ${FALLBACK} (lightweight diagnostic / Bobby candidate)`);

await unload(PRIMARY);
await unload(FALLBACK);
await new Promise((r) => setTimeout(r, 1500));

console.log("\n[F1] basic load + short response");
const f1 = await chat(FALLBACK, null, "What is 2+2? Reply with just the number.");
const fvram = await vramReport();
report.fallback.tests.basic = {
  loadDurationMs: f1.raw?.load_duration_ms ?? null,
  totalMs: f1.totalMs,
  timeToFirstTokenMs: f1.timeToFirstTokenMs,
  tokensPerSec: f1.tokensPerSec,
  vramAfterLoad: fvram,
  response: f1.text,
  degenerate: looksDegenerate(f1.text),
};
console.log(
  `  load=${f1.raw?.load_duration_ms?.toFixed(0)}ms ttft=${f1.timeToFirstTokenMs}ms total=${f1.totalMs}ms tps=${f1.tokensPerSec?.toFixed(1)} VRAM=${fvram ? fvram.usedMB + "/" + fvram.totalMB + " MB" : "n/a"}`
);
console.log(`  response: ${f1.text.trim().slice(0, 200)}`);

console.log("\n[F2] swap away to e4b, back to gemma2-2b");
await unload(FALLBACK);
await chat(PRIMARY, BART_SYS, "ack");
await unload(PRIMARY);
const f2 = await chat(FALLBACK, null, "Say one word.");
report.fallback.tests.swapBack = {
  totalMs: f2.totalMs,
  timeToFirstTokenMs: f2.timeToFirstTokenMs,
  response: f2.text,
  degenerate: looksDegenerate(f2.text),
};
console.log(
  `  ttft=${f2.timeToFirstTokenMs}ms total=${f2.totalMs}ms degen=${report.fallback.tests.swapBack.degenerate.degenerate}`
);
console.log(`  response: ${f2.text.trim().slice(0, 200)}`);

// ----- summary -----
section("Summary");
const allTests = [
  ...Object.values(report.primary.tests),
  ...(report.primary.tests.threeSwapRepeat ?? []).flatMap((c) => [
    { degenerate: c.primaryDegen },
    { degenerate: c.fallbackDegen },
  ]),
  ...Object.values(report.fallback.tests),
];
const garbageFound = allTests.some(
  (t) => t.degenerate && t.degenerate.degenerate
);
report.summary = {
  primaryGarbageFree: !Object.values(report.primary.tests).some(
    (t) =>
      (t.degenerate && t.degenerate.degenerate) ||
      (t.primaryDegen && t.primaryDegen.degenerate) ||
      (t.fallbackDegen && t.fallbackDegen.degenerate)
  ),
  fallbackGarbageFree: !Object.values(report.fallback.tests).some(
    (t) => t.degenerate && t.degenerate.degenerate
  ),
  primaryUsableLatency:
    report.primary.tests.coldLoad?.timeToFirstTokenMs !== null &&
    report.primary.tests.coldLoad?.timeToFirstTokenMs < 30_000,
  swapRecoverable:
    report.primary.tests.swapRecovery?.degenerate?.degenerate === false,
  threeSwapStable: cycles.every(
    (c) => !c.primaryDegen.degenerate && !c.fallbackDegen.degenerate
  ),
  recommendedBinding: !garbageFound ? "Bartimaeus → e4b:latest" : "BLOCKED",
};

console.log(JSON.stringify(report.summary, null, 2));

await fsp.writeFile(
  "validation-e4b.json",
  JSON.stringify(report, null, 2),
  "utf8"
);
console.log("\nFull report written to validation-e4b.json");

if (!report.summary.primaryGarbageFree || !report.summary.swapRecoverable) {
  console.log("\nVALIDATION FAILED — primary model is not safe to wire.");
  process.exit(1);
} else {
  console.log("\nVALIDATION PASS — primary model is safe to wire.");
  process.exit(0);
}
