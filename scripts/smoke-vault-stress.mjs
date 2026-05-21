#!/usr/bin/env node
// smoke-vault-stress.mjs
//
// Multi-document ingest + retrieval stress test. Walks the project's
// own docs/ and methodology/ directories and uploads every markdown
// file to the vault, then verifies the vault index can serve a
// search against the populated corpus.
//
// This is the "real-world" load test — the doctrine + methodology
// corpus is what the operator will likely vault for demo day, so
// stressing that exact workload now finds regressions that the
// smaller smoke-vault.mjs would miss.
//
// Reports per-doc ingest timings, total payload, embedding throughput.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip nested sessions dir to keep the corpus small
      if (entry.name === "sessions") continue;
      out.push(...findMarkdown(full));
    } else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

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
  if (!r.ok) throw new Error(`upload ${filename} failed ${r.status}: ${await r.text()}`);
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
  throw new Error(`upload ${filename}: no done event`);
}

async function search(query, topK = 5) {
  const r = await fetch(`${BASE}/api/vault/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, topK }),
  });
  if (!r.ok) throw new Error(`search failed ${r.status}: ${await r.text()}`);
  return (await r.json()).hits;
}

// ---------- main ----------
console.log(`smoke-vault-stress — corpus ingest + retrieval`);
console.log("=".repeat(72));

const docPaths = [
  ...findMarkdown(path.join(ROOT, "docs")),
  ...findMarkdown(path.join(ROOT, "methodology")),
];
console.log(`\nDiscovered ${docPaths.length} markdown files in docs/ + methodology/`);
let totalBytes = 0;
for (const p of docPaths) totalBytes += statSync(p).size;
console.log(`Total corpus size: ${(totalBytes / 1024).toFixed(1)} KB`);

const initial = await listDocs();
const preExisting = new Set(initial.documents.map((d) => d.docId));
console.log(`Pre-existing docs: ${preExisting.size}`);

const uploaded = [];
const tIngestStart = Date.now();
let totalChunks = 0;
let perDocTimes = [];

console.log(`\n[ingest]`);
for (const docPath of docPaths) {
  const relName = path.relative(ROOT, docPath).replace(/[\\/]/g, "_");
  const content = readFileSync(docPath, "utf8");
  const t0 = Date.now();
  try {
    const result = await uploadDoc(relName, content);
    const ms = Date.now() - t0;
    uploaded.push(result.docId);
    totalChunks += result.chunkCount;
    perDocTimes.push({ name: relName, ms, chunks: result.chunkCount, bytes: content.length });
    console.log(
      `  ✓ ${relName.padEnd(45)} ${`${result.chunkCount}c`.padStart(5)} ${`${ms}ms`.padStart(7)}`
    );
  } catch (e) {
    console.log(`  ✗ ${relName.padEnd(45)} FAIL: ${e.message.slice(0, 80)}`);
  }
}
const tIngestTotal = Date.now() - tIngestStart;

// ---------- retrieval probes ----------
console.log(`\n[retrieval probes]`);
// Each probe: query + accepting filename patterns. The expectFile
// regex is the union of "any file that would be a legit top hit for
// this query" — eyes-on-h7 documents the launcher hour, eyes-on-h8
// has the drive incident, etc.
const probes = [
  { q: "what are the seven usb-native rules?", expectFile: /seven-rules|doctrine/i },
  { q: "how does the launcher handle clean shutdown?", expectFile: /launcher|operations|seven-rules|eyes-on-h7/i },
  { q: "what is the vault embedding model?", expectFile: /decisions|eyes-on|operations|gates/i },
  { q: "drive letter reassignment incident", expectFile: /corrections|eyes-on-h8/i },
];

let probePassed = 0;
let probeFailed = 0;
for (const { q, expectFile } of probes) {
  const t0 = Date.now();
  const hits = await search(q, 3);
  const ms = Date.now() - t0;
  if (hits.length === 0) {
    console.log(`  ✗ "${q}" → no hits (${ms}ms)`);
    probeFailed++;
    continue;
  }
  const top = hits[0];
  const matchedFile = expectFile.test(top.filename);
  if (matchedFile) {
    probePassed++;
    console.log(`  ✓ "${q}" → ${top.filename} score=${top.score.toFixed(3)} (${ms}ms)`);
  } else {
    probeFailed++;
    console.log(
      `  ✗ "${q}" → ${top.filename} (expected match ${expectFile}) score=${top.score.toFixed(3)} (${ms}ms)`
    );
  }
}

// ---------- cleanup ----------
console.log(`\n[cleanup] removing ${uploaded.length} uploaded docs...`);
for (const docId of uploaded) {
  try {
    await deleteDoc(docId);
  } catch (e) {
    console.log(`  ! ${docId.slice(0, 8)} delete failed: ${e.message}`);
  }
}

// ---------- summary ----------
console.log("\n" + "=".repeat(72));
console.log(`smoke-vault-stress`);
console.log(`  docs ingested:       ${uploaded.length}/${docPaths.length}`);
console.log(`  total chunks:        ${totalChunks}`);
console.log(`  total bytes:         ${(totalBytes / 1024).toFixed(1)} KB`);
console.log(`  total ingest time:   ${tIngestTotal} ms (${(totalBytes / 1024 / (tIngestTotal / 1000)).toFixed(1)} KB/s)`);
if (perDocTimes.length > 0) {
  const times = perDocTimes.map((d) => d.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`  per-doc p50:         ${p50} ms`);
  console.log(`  per-doc p95:         ${p95} ms`);
}
console.log(`  retrieval probes:    ${probePassed} PASS, ${probeFailed} FAIL`);
const allOk = uploaded.length === docPaths.length && probeFailed === 0;
console.log(allOk ? "\nstress test PASS" : "\nstress test FAIL");
process.exit(allOk ? 0 : 1);
