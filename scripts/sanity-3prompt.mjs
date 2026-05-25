#!/usr/bin/env node
// sanity-3prompt.mjs — Phase 2 Hardware Reality Plan harness.
//
// Runs the 3 directive prompts against every installed chat-capable
// Ollama model. Captures: cold load, first-token latency, total
// response time, tok/s, basic degenerate-token check. Writes JSON
// to sanity-3prompt.json alongside human-readable stdout.
//
// Deliberately tiny — meant for the PLAN doc, not for wiring decisions.
// No system prompt; no think:false; baseline behavior only.

import { promises as fsp } from "node:fs";

const OLLAMA = process.env.OLLAMA_HOST?.startsWith("http")
  ? process.env.OLLAMA_HOST
  : `http://${process.env.OLLAMA_HOST || "127.0.0.1:11434"}`;

const PROMPTS = {
  A: "Say one normal sentence.",
  B: "Explain epistemic humility in two paragraphs.",
  C: "Give me three concrete next steps for stabilizing a local AI app.",
};

function looksDegenerate(text) {
  if (!text || text.length === 0) return { degenerate: true, reason: "empty" };
  if (/(.{8,})\1{4,}/.test(text)) {
    return { degenerate: true, reason: "8-char fragment repeats 5+ times" };
  }
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 20) {
    const counts = {};
    for (const w of words) counts[w] = (counts[w] || 0) + 1;
    const most = Math.max(...Object.values(counts));
    if (most / words.length > 0.6) {
      return {
        degenerate: true,
        reason: `single token = ${((most / words.length) * 100).toFixed(0)}% of output`,
      };
    }
  }
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

async function chat(model, userPrompt) {
  const start = Date.now();
  let firstAt = null;
  let text = "";
  let thinking = "";
  let stats = null;
  const body = {
    model,
    messages: [{ role: "user", content: userPrompt }],
    stream: true,
    think: false,
    options: { think: false },
  };
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
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
        try { j = JSON.parse(line); } catch { continue; }
        const chunk = j?.message?.content;
        const think = j?.message?.thinking;
        if (chunk) { if (firstAt === null) firstAt = Date.now(); text += chunk; }
        if (think) thinking += think;
        if (j?.done) {
          stats = {
            eval_count: j.eval_count ?? 0,
            eval_duration_ms: j.eval_duration ? j.eval_duration / 1e6 : 0,
            load_duration_ms: j.load_duration ? j.load_duration / 1e6 : 0,
            total_duration_ms: j.total_duration ? j.total_duration / 1e6 : 0,
          };
        }
      }
      nl = buf.indexOf("\n");
    }
  }
  const tps = stats?.eval_duration_ms && stats.eval_count
    ? (stats.eval_count / stats.eval_duration_ms) * 1000
    : null;
  return {
    text,
    thinking,
    totalMs: Date.now() - start,
    ttftMs: firstAt ? firstAt - start : null,
    tps,
    raw: stats,
  };
}

async function unload(model) {
  try {
    await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* best-effort */ }
}

async function vramReport() {
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
  } catch { return null; }
}

const tagsRes = await fetch(`${OLLAMA}/api/tags`, {
  signal: AbortSignal.timeout(5_000),
});
const tags = await tagsRes.json();
// Skip embed-only models (no completion capability) — we'd 404 on /api/chat.
const allModels = tags.models.map((m) => m.name);
const chatModels = [];
for (const name of allModels) {
  try {
    const show = await fetch(`${OLLAMA}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000),
    });
    const detail = await show.json();
    const caps = detail.capabilities || [];
    if (caps.includes("completion") || caps.length === 0) {
      chatModels.push({
        name,
        family: detail.details?.family || "?",
        parameter_size: detail.details?.parameter_size || "?",
        quant: detail.details?.quantization_level || "?",
        capabilities: caps,
      });
    } else {
      console.log(`skipping ${name} (capabilities: ${caps.join(",")} — no completion)`);
    }
  } catch (e) {
    console.warn(`could not introspect ${name}: ${e.message}`);
  }
}

const report = {
  timestamp: new Date().toISOString(),
  ollamaHost: OLLAMA,
  installedModels: tags.models.map((m) => ({
    name: m.name,
    sizeBytes: m.size,
    sizeGB: +(m.size / 1024 ** 3).toFixed(2),
    modified: m.modified_at,
  })),
  chatModels,
  baselineVramMB: (await vramReport())?.usedMB ?? null,
  results: {},
};

console.log("=== Pre-flight ===");
console.log(`installed: ${allModels.join(", ")}`);
console.log(`chat-capable: ${chatModels.map((m) => m.name).join(", ")}`);
console.log(`baseline VRAM: ${report.baselineVramMB ?? "n/a"} MB`);

// Unload everything first so cold-load timings are real
for (const m of allModels) await unload(m);
await new Promise((r) => setTimeout(r, 1500));

for (const m of chatModels) {
  console.log("");
  console.log(`=== ${m.name}  (${m.family} ${m.parameter_size} ${m.quant}) ===`);
  report.results[m.name] = { meta: m, prompts: {} };
  for (const [key, prompt] of Object.entries(PROMPTS)) {
    try {
      const r = await chat(m.name, prompt);
      const vram = await vramReport();
      const dg = looksDegenerate(r.text);
      report.results[m.name].prompts[key] = {
        prompt,
        text: r.text,
        thinkingChars: r.thinking.length,
        totalMs: r.totalMs,
        ttftMs: r.ttftMs,
        tps: r.tps,
        evalCount: r.raw?.eval_count ?? null,
        loadDurationMs: r.raw?.load_duration_ms ?? null,
        vramAfterMB: vram?.usedMB ?? null,
        degenerate: dg,
      };
      const tps = r.tps ? r.tps.toFixed(1) : "n/a";
      const load = r.raw?.load_duration_ms ? `${r.raw.load_duration_ms.toFixed(0)}ms` : "n/a";
      console.log(`  ${key}: ttft=${r.ttftMs}ms total=${r.totalMs}ms tps=${tps} load=${load} vram=${vram?.usedMB ?? "?"}MB degen=${dg.degenerate}`);
      const snip = r.text.trim().replace(/\s+/g, " ").slice(0, 240);
      console.log(`     "${snip}${r.text.length > 240 ? "…" : ""}"`);
    } catch (e) {
      report.results[m.name].prompts[key] = { prompt, error: e.message };
      console.log(`  ${key}: ERROR ${e.message}`);
    }
  }
  // Unload before next model so each gets a clean cold-load measurement
  await unload(m.name);
  await new Promise((r) => setTimeout(r, 1000));
}

await fsp.writeFile("sanity-3prompt.json", JSON.stringify(report, null, 2), "utf8");
console.log("");
console.log("Wrote sanity-3prompt.json");
