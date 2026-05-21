#!/usr/bin/env node
// warm-ollama.mjs
//
// Pre-load the chat + embedding models into VRAM/RAM so the first
// user-visible chat hit is sub-second instead of ~7-8s (cold model
// load on llama3.1:8b on an RTX 3060 Ti, measured in Phase K).
//
// Hits Ollama directly (not through the Next.js proxy) so it works
// whether or not the Next.js server is up. Reads OLLAMA_HOST from
// env (default 127.0.0.1:11434) — matches lib/ollama-config.ts.
//
// Recommended use: after launcher reports "ARGOS ready", in a second
// terminal:  npm run warm
//
// The cost: ~6-10 seconds of one-time work, returns when both models
// have served a 1-token request and confirmed ready.

import { setTimeout as sleep } from "node:timers/promises";

function ollamaBase() {
  const raw = process.env.OLLAMA_HOST;
  if (!raw) return "http://127.0.0.1:11434";
  const trimmed = raw.trim();
  if (!trimmed) return "http://127.0.0.1:11434";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
  return `http://${trimmed}`.replace(/\/$/, "");
}

const BASE = ollamaBase();
const CHAT_MODEL = process.env.WARM_CHAT_MODEL || "llama3.1:8b-instruct-q4_K_M";
const EMBED_MODEL = process.env.WARM_EMBED_MODEL || "nomic-embed-text";

console.log(`warm-ollama — preloading models into VRAM`);
console.log(`  base:         ${BASE}`);
console.log(`  chat model:   ${CHAT_MODEL}`);
console.log(`  embed model:  ${EMBED_MODEL}`);
console.log("");

async function waitForDaemon(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return Date.now() - t0;
    } catch {
      /* not ready */
    }
    await sleep(500);
  }
  throw new Error(`Ollama daemon at ${BASE} did not respond within ${timeoutMs}ms`);
}

async function listModels() {
  const r = await fetch(`${BASE}/api/tags`);
  if (!r.ok) throw new Error(`list failed ${r.status}`);
  const j = await r.json();
  return new Set((j.models || []).map((m) => m.name || m.model));
}

async function warmChat(model) {
  const t0 = Date.now();
  // 1-token prompt with stream:false returns once the model finishes
  // generating, which means it's fully loaded by then.
  const r = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "hi",
      stream: false,
      options: { num_predict: 1 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  if (!r.ok) {
    throw new Error(`warm-chat failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  return { ms, loadMs: Math.round((j.load_duration || 0) / 1_000_000) };
}

async function warmEmbed(model) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "warm" }),
    signal: AbortSignal.timeout(60_000),
  });
  const ms = Date.now() - t0;
  if (!r.ok) {
    throw new Error(`warm-embed failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  if (!Array.isArray(j.embedding) || j.embedding.length === 0) {
    throw new Error(`warm-embed returned no embedding`);
  }
  return { ms, dims: j.embedding.length };
}

// ---------- main ----------
try {
  process.stdout.write(`[1/4] waiting for ollama daemon ... `);
  const waitMs = await waitForDaemon();
  console.log(`ready (${waitMs}ms)`);

  process.stdout.write(`[2/4] listing installed models ... `);
  const installed = await listModels();
  console.log(`${installed.size} found`);

  // Tolerant lookup: ollama tags can be returned as "name:latest" even
  // when pulled without a tag. Look for any model that starts with the
  // base name.
  function findMatching(target) {
    if (installed.has(target)) return target;
    for (const name of installed) {
      if (name === target) return name;
      if (name.startsWith(`${target}:`)) return name;
      if (target.startsWith(`${name}:`)) return name;
      // nomic-embed-text vs nomic-embed-text:latest
      const base = target.split(":")[0];
      if (name === base || name.startsWith(`${base}:`)) return name;
    }
    return null;
  }

  const resolvedChat = findMatching(CHAT_MODEL);
  const resolvedEmbed = findMatching(EMBED_MODEL);

  if (!resolvedChat) {
    console.log(`\n[FAIL] chat model "${CHAT_MODEL}" not in ollama list.`);
    console.log(`Pull it with:  ollama pull ${CHAT_MODEL}`);
    process.exit(1);
  }
  if (!resolvedEmbed) {
    console.log(`\n[FAIL] embed model "${EMBED_MODEL}" not in ollama list.`);
    console.log(`Pull it with:  ollama pull ${EMBED_MODEL}`);
    process.exit(1);
  }

  process.stdout.write(`[3/4] warming chat model (${resolvedChat}) ... `);
  const chatResult = await warmChat(resolvedChat);
  console.log(`ok (${chatResult.ms}ms, load_duration=${chatResult.loadMs}ms)`);

  process.stdout.write(`[4/4] warming embed model (${resolvedEmbed}) ... `);
  const embedResult = await warmEmbed(resolvedEmbed);
  console.log(`ok (${embedResult.ms}ms, ${embedResult.dims} dims)`);

  console.log("");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  Models now warm in VRAM/RAM.`);
  console.log(`  First user chat should now respond in <1s instead of ~8s.`);
  console.log("════════════════════════════════════════════════════════════");
  process.exit(0);
} catch (e) {
  console.log("");
  console.log(`[FAIL] ${e.message}`);
  process.exit(1);
}
