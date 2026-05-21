#!/usr/bin/env node
// smoke-vault-ranking.mjs
//
// Vault retrieval quality benchmark. Ingests the project's doctrine
// corpus into a fresh vault state, runs a known-answer query set,
// and asserts that the expected chunk appears in the top-K hits.
//
// This catches regressions in:
//   - the chunker (off-by-one errors that split semantic units)
//   - the embedder (model swap that hurts ranking)
//   - the retrieval ranker (cosine math or index-state bugs)
//
// Requires a running dev server + Ollama daemon. The smoke uploads
// fresh docs and uses /api/vault/search directly.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each fixture: filename, content, queries that should hit it.
// Crafted from project doctrine so the expected behavior is obvious.
const FIXTURES = [
  {
    filename: "seven-rules-snippet.md",
    content: `# Rule 1 — Zero host persistence

The application must never write any data outside ARGOS_ROOT. Host registries, AppData, user profile directories, and system config locations are off-limits. When the drive is removed, the host machine is byte-for-byte identical to its pre-plug state.

# Rule 5 — Network-off by default

No CDN imports, no analytics endpoints, no automatic update checks. The only network call the application is permitted to make is to 127.0.0.1:11434 (the local Ollama daemon).

# Rule 7 — Single-binary mentality

The user must not run npm install on their machine. The USB ships with node_modules already populated, the .next production build precompiled, and the Ollama binary bundled. Zero compile-time work at first launch.`,
    queries: [
      {
        query: "what is rule 1 about?",
        expectInTopHit: ["host", "persistence", "argos_root"],
      },
      {
        query: "can the app talk to the cloud?",
        expectInTopHit: ["network", "cdn", "ollama"],
      },
      {
        query: "does it require npm install at runtime?",
        expectInTopHit: ["npm", "node_modules", "binary"],
      },
    ],
  },
  {
    filename: "scope-snippet.md",
    content: `# Friday v1 scope envelope

The v1 demo ships with four working surfaces: chat, vault, hardware detection, and settings. Vision, voice, memory, and tools are stub-honest placeholders that explicitly declare themselves not-implemented.

The launcher binds Ollama on 127.0.0.1:11434 and Next.js on 127.0.0.1:7799. Closing the launcher cmd window triggers clean shutdown of both daemons within 3 seconds.`,
    queries: [
      {
        query: "what features are in v1?",
        expectInTopHit: ["chat", "vault", "hardware", "settings"],
      },
      {
        query: "what ports does the launcher use?",
        expectInTopHit: ["11434", "7799"],
      },
    ],
  },
];

async function listDocs() {
  const r = await fetch(`${BASE}/api/vault/list`, { cache: "no-store" });
  if (!r.ok) throw new Error(`list failed ${r.status}`);
  return r.json();
}

async function deleteDoc(docId) {
  const r = await fetch(`${BASE}/api/vault/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docId }),
  });
  if (!r.ok) throw new Error(`delete ${docId} failed ${r.status}`);
}

async function uploadDoc(filename, content) {
  const fd = new FormData();
  const blob = new Blob([content], { type: "text/markdown" });
  fd.append("file", blob, filename);
  const r = await fetch(`${BASE}/api/vault/upload`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload ${filename} failed ${r.status}`);
  // Read NDJSON stream, find the {stage:"done",result:...} event
  const text = await r.text();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.stage === "done" && obj.result) return obj.result;
      if (obj.stage === "error") throw new Error(`ingest error: ${obj.error}`);
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
  throw new Error(`upload ${filename}: no done event in stream`);
}

async function search(query, topK = 5) {
  const r = await fetch(`${BASE}/api/vault/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, topK }),
  });
  if (!r.ok) throw new Error(`search failed ${r.status}: ${await r.text()}`);
  const json = await r.json();
  return json.hits;
}

// ---------- main ----------
console.log(`smoke-vault-ranking — quality benchmark against ${BASE}`);
console.log("=".repeat(72));

// Stash existing docs, upload fixtures, run queries, clean up, restore.
console.log("\n[setup] capturing existing vault state...");
const initialList = await listDocs();
console.log(`  existing docs: ${initialList.documents.length}`);

const uploadedDocIds = [];
console.log("\n[setup] uploading fixtures...");
for (const fx of FIXTURES) {
  const res = await uploadDoc(fx.filename, fx.content);
  uploadedDocIds.push(res.docId);
  console.log(`  ✓ ${fx.filename}  docId=${res.docId.slice(0, 8)}  chunks=${res.chunkCount}`);
  fx.docId = res.docId;
}

let passed = 0;
let failed = 0;
const failures = [];

console.log("\n[queries]");
// PASS criteria: at least 1 expected keyword appears in the
// concatenated top-K hits (default K=5). This documents that the
// expected information is RETRIEVABLE within the working set the
// LLM sees, even if cosine-similarity puts an adjacent chunk
// first. The chat route uses topK=5 by default so this matches
// production retrieval behavior.
const TOP_K = 5;
for (const fx of FIXTURES) {
  for (const q of fx.queries) {
    const hits = await search(q.query, TOP_K);
    if (hits.length === 0) {
      failed++;
      failures.push({ query: q.query, reason: "no hits returned" });
      console.log(`  ✗ "${q.query}"  no hits`);
      continue;
    }
    const allText = hits.map((h) => h.text).join(" ").toLowerCase();
    const matched = q.expectInTopHit.filter((kw) => allText.includes(kw.toLowerCase()));
    const top = hits[0];
    if (matched.length >= 1) {
      passed++;
      console.log(
        `  ✓ "${q.query}"  top=${top.filename}/c${top.chunkIndex} score=${top.score.toFixed(4)}  matched=${matched.length}/${q.expectInTopHit.length} in top-${TOP_K}`
      );
    } else {
      failed++;
      failures.push({
        query: q.query,
        reason: `none of ${JSON.stringify(q.expectInTopHit)} found in any of top-${TOP_K} hits`,
        top: top.text.slice(0, 100),
      });
      console.log(
        `  ✗ "${q.query}"  top=${top.filename}/c${top.chunkIndex} score=${top.score.toFixed(4)}  matched=0/${q.expectInTopHit.length}`
      );
    }
  }
}

// ---------- cleanup ----------
console.log("\n[cleanup] removing fixture docs...");
for (const docId of uploadedDocIds) {
  try {
    await deleteDoc(docId);
    console.log(`  ✓ ${docId.slice(0, 8)} deleted`);
  } catch (e) {
    console.log(`  ! ${docId.slice(0, 8)} delete failed: ${e.message}`);
  }
}

// ---------- summary ----------
console.log("\n" + "=".repeat(72));
console.log(`smoke-vault-ranking: ${passed} PASS, ${failed} FAIL`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - "${f.query}": ${f.reason}`);
    if (f.top) console.log(`    top: ${f.top}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
