#!/usr/bin/env node
// smoke-all-models.mjs
//
// Loads each of the three models ARGOS ships with against a running
// Ollama daemon and confirms it produces a non-empty response. Prints
// per-model timings (load + first-token + total).
//
// Models tested:
//   - nomic-embed-text       (vault embeddings)
//   - qwen2.5:3b-instruct-q4_K_M  (fast-path chat)
//   - llama3.1:8b-instruct-q4_K_M (default chat)
//
// Usage:
//   node scripts/smoke-all-models.mjs
//
// Env:
//   OLLAMA_HOST=127.0.0.1:11434    (override base; reads same env as daemon)

// We re-implement getOllamaBase here so this script is runnable under
// plain node (no TS step). Kept in sync with lib/ollama-config.ts.
function ollamaBase() {
  const raw = process.env.OLLAMA_HOST;
  if (!raw) return "http://127.0.0.1:11434";
  const trimmed = raw.trim();
  if (!trimmed) return "http://127.0.0.1:11434";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
  return `http://${trimmed}`.replace(/\/$/, "");
}

const BASE = ollamaBase();

const tests = [
  {
    name: "nomic-embed-text",
    type: "embed",
    endpoint: "/api/embeddings",
    body: () => ({ model: "nomic-embed-text", prompt: "test embedding input" }),
    validate: (json) => Array.isArray(json.embedding) && json.embedding.length > 100,
  },
  {
    name: "qwen2.5:3b-instruct-q4_K_M",
    type: "chat",
    endpoint: "/api/generate",
    body: () => ({
      model: "qwen2.5:3b-instruct-q4_K_M",
      prompt: "Say hello in exactly 3 words.",
      stream: false,
    }),
    validate: (json) => typeof json.response === "string" && json.response.trim().length > 0,
  },
  {
    name: "llama3.1:8b-instruct-q4_K_M",
    type: "chat",
    endpoint: "/api/generate",
    body: () => ({
      model: "llama3.1:8b-instruct-q4_K_M",
      prompt: "Say hello in exactly 3 words.",
      stream: false,
    }),
    validate: (json) => typeof json.response === "string" && json.response.trim().length > 0,
  },
];

async function runOne(test) {
  const t0 = Date.now();
  let httpFirstByteMs = null;
  let totalMs = null;
  let evalCount = null;
  let evalDurationMs = null;
  let loadDurationMs = null;
  let preview = "";

  try {
    const res = await fetch(`${BASE}${test.endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(test.body()),
      signal: AbortSignal.timeout(120_000),
    });
    httpFirstByteMs = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json();
    totalMs = Date.now() - t0;
    if (!test.validate(json)) {
      return { ok: false, error: `validation failed: ${JSON.stringify(json).slice(0, 200)}` };
    }
    // Pull Ollama metrics if present (chat returns these; embed does not)
    if (typeof json.eval_count === "number") evalCount = json.eval_count;
    if (typeof json.eval_duration === "number")
      evalDurationMs = Math.round(json.eval_duration / 1_000_000);
    if (typeof json.load_duration === "number")
      loadDurationMs = Math.round(json.load_duration / 1_000_000);
    if (test.type === "chat") preview = (json.response || "").trim().slice(0, 80);
    if (test.type === "embed") preview = `[${json.embedding.length} dims]`;
    return {
      ok: true,
      httpFirstByteMs,
      totalMs,
      evalCount,
      evalDurationMs,
      loadDurationMs,
      preview,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

console.log(`smoke-all-models — testing 3 models against ${BASE}`);
console.log("=".repeat(72));

const results = [];
for (const t of tests) {
  process.stdout.write(`\n[${t.type.toUpperCase()}] ${t.name} ... `);
  const r = await runOne(t);
  results.push({ test: t.name, ...r });
  if (r.ok) {
    process.stdout.write(`OK (${r.totalMs}ms)\n`);
    if (r.loadDurationMs !== null) process.stdout.write(`  load_duration:      ${r.loadDurationMs} ms\n`);
    if (r.evalCount !== null) process.stdout.write(`  eval_count:         ${r.evalCount} tokens\n`);
    if (r.evalDurationMs !== null && r.evalCount !== null) {
      const tps = ((r.evalCount * 1000) / r.evalDurationMs).toFixed(2);
      process.stdout.write(`  tokens/sec:         ${tps}\n`);
    }
    process.stdout.write(`  preview:            ${r.preview}\n`);
  } else {
    process.stdout.write(`FAIL\n  ${r.error}\n`);
  }
}

console.log("\n" + "=".repeat(72));
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`smoke-all-models: ${passed}/${results.length} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
