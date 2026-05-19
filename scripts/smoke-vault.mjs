#!/usr/bin/env node
// Smoke test for the H3 vault pipeline against a live dev server + Ollama.
// 1) Writes a sample markdown doc (dogfood: the Seven Rules)
// 2) POSTs to /api/vault/upload, streams progress
// 3) GETs /api/vault/list
// 4) POSTs to /api/vault/search with a relevance probe
// 5) Asserts top hit mentions "path" or "relative"

import { writeFile, unlink, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const PROBE = "USB native rule for paths";

const DOC = `# The Seven USB-Native Rules of ARGOS

ARGOS is a local-first AI workstation that runs entirely from removable media. The Seven Rules are hard architectural gates, not guidelines.

## Rule 1 — Zero host persistence

The application must never write any data outside ARGOS_ROOT. Host registries, AppData, user profile directories, and system config locations are off-limits. When the drive is removed, the host machine is byte-for-byte identical to its pre-plug state.

## Rule 2 — Zero registry or system config writes

No Windows registry entries. No macOS plist files. No systemd units. All state lives under ARGOS/config/ on the removable drive itself.

## Rule 3 — Relative paths only

Source code must never hardcode a user-home path. No Windows drive-letter user directories. No Unix-style home directories. Every storage path derives from ARGOS_ROOT via path.join. The relative-path discipline is what makes the drive portable across machines.

## Rule 4 — Scoped environment variables

Child process environment may be augmented for ARGOS itself, but the user's shell environment must never be modified. We do not call setx, export to .bashrc, or touch the registry's Environment key.

## Rule 5 — Network-off by default

No CDN imports. No analytics, no Sentry, no telemetry beacons. The only network endpoint allowed at runtime is localhost (Ollama lives at 127.0.0.1:11434).

## Rule 6 — Graceful eject

Clean shutdown within three seconds: flush in-flight writes, release file handles, terminate child processes. The OS-level eject must not error.

## Rule 7 — Single-binary mentality

No npm install on the user's machine. The shipped drive is fully self-contained — runtime, models, vault, all of it.
`;

async function main() {
  // Write the sample doc to a temp location outside the working tree
  const tmpDir = path.join(os.tmpdir(), "argos-smoke");
  await mkdir(tmpDir, { recursive: true });
  const docPath = path.join(tmpDir, "seven-rules-sample.md");
  await writeFile(docPath, DOC, "utf8");
  const docStat = await stat(docPath);
  console.log(`SAMPLE_DOC ${docPath} (${docStat.size} bytes)`);

  // STEP A: upload
  const fd = new FormData();
  fd.append("file", new Blob([DOC], { type: "text/markdown" }), "seven-rules-sample.md");
  const upStart = performance.now();
  const upRes = await fetch(`${BASE}/api/vault/upload`, {
    method: "POST",
    body: fd,
  });
  if (!upRes.ok || !upRes.body) {
    console.error(`UPLOAD FAILED ${upRes.status}: ${await upRes.text()}`);
    process.exit(1);
  }
  const reader = upRes.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finalResult = null;
  let stages = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const obj = JSON.parse(line);
        stages.push(obj);
        if (obj.stage === "error") {
          console.error(`INGEST ERROR: ${obj.error}`);
          process.exit(1);
        }
        if (obj.stage === "done") finalResult = obj.result;
      }
      nl = buf.indexOf("\n");
    }
  }
  const upDuration = performance.now() - upStart;
  console.log(`UPLOAD_TOTAL_MS         ${upDuration.toFixed(1)}`);
  console.log(`PROGRESS_STAGES         ${stages.map((s) => s.stage).join(" → ")}`);
  if (!finalResult) {
    console.error("NO_FINAL_RESULT");
    process.exit(1);
  }
  console.log(`DOC_ID                  ${finalResult.docId}`);
  console.log(`FILENAME                ${finalResult.filename}`);
  console.log(`CHUNK_COUNT             ${finalResult.chunkCount}`);
  console.log(`BYTE_SIZE               ${finalResult.byteSize}`);
  console.log(`INGEST_TOTAL_MS         ${finalResult.durationMs.toFixed(1)}`);
  console.log(`EMBED_TOTAL_MS          ${finalResult.embeddingDurationMs.toFixed(1)}`);
  console.log(
    `EMBED_MS_PER_CHUNK      ${(finalResult.embeddingDurationMs / finalResult.chunkCount).toFixed(1)}`
  );

  // STEP B: list
  const listRes = await fetch(`${BASE}/api/vault/list`);
  if (!listRes.ok) {
    console.error(`LIST FAILED ${listRes.status}`);
    process.exit(1);
  }
  const listJson = await listRes.json();
  console.log(`LIST_DOC_COUNT          ${listJson.documents.length}`);
  console.log(`LIST_TOTAL_CHUNKS       ${listJson.totalChunks}`);

  // STEP C: search
  const sRes = await fetch(`${BASE}/api/vault/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: PROBE, topK: 3 }),
  });
  if (!sRes.ok) {
    console.error(`SEARCH FAILED ${sRes.status}: ${await sRes.text()}`);
    process.exit(1);
  }
  const sJson = await sRes.json();
  console.log(`\nSEARCH PROBE            "${PROBE}"`);
  console.log(`TOP_${sJson.hits.length}_HITS:`);
  for (let i = 0; i < sJson.hits.length; i++) {
    const h = sJson.hits[i];
    const snippet = h.text.replace(/\s+/g, " ").slice(0, 140);
    console.log(`  #${i + 1}  score=${h.score.toFixed(4)}  chunk=${h.chunkIndex}  ${snippet}…`);
  }

  // ASSERTION
  const top = sJson.hits[0];
  const topLower = top.text.toLowerCase();
  const passed = topLower.includes("path") || topLower.includes("relative");
  console.log(`\nASSERTION (top hit contains "path" or "relative"): ${passed ? "PASS" : "FAIL"}`);

  await unlink(docPath).catch(() => {});
  if (!passed) process.exit(1);
}

main().catch((e) => {
  console.error("SMOKE_ERROR:", e);
  process.exit(1);
});
