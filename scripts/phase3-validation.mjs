#!/usr/bin/env node
// phase3-validation.mjs — Phase 3-B validation harness.
//
// Boots a dev server pointed at the DEPLOYED Desktop ARGOS_ROOT (so the
// seeded EKG vault/raw/ corpus is visible). Triggers auto-ingest. Runs
// the 5 directive validation queries via /api/vault/search (raw retrieval
// — no LLM in the loop, so we see exactly which chunks score how).
// Captures: query → ranked hits with scores + confidence buckets.
//
// Also tests the false-citation gate: Query 5 must return zero results
// above the configured floor.
//
// Output: JSON to phase3-validation.json + human-readable to stdout/log.

import { spawn, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { writeFile } from "node:fs/promises";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 7795;
const argosRootArgIdx = process.argv.indexOf("--argos-root");
// Resolution order: --argos-root flag > $ARGOS_ROOT env > process.cwd().
// No hardcoded absolute path — Rule 1 compliant.
const ARGOS_ROOT =
  argosRootArgIdx >= 0
    ? process.argv[argosRootArgIdx + 1]
    : process.env.ARGOS_ROOT || process.cwd();
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

const QUERIES = [
  { id: "Q1", q: "What happens when a guard calls off three times?",
    expectedSources: ["calloff-management.md", "performance-review-triggers.md"] },
  { id: "Q2", q: "How do I handle overtime billing for a client?",
    expectedSources: ["client-contract-terms.md", "overtime-controls.md"] },
  { id: "Q3", q: "Guard used force on a trespasser — what's the protocol?",
    expectedSources: ["use-of-force-policy.md", "incident-response-sop.md"] },
  { id: "Q4", q: "What certifications does a guard need for a firearm post?",
    expectedSources: ["certification-requirements.md"] },
  { id: "Q5", q: "What is the boiling point of water?",
    expectedSources: [],
    falseCitationTest: true,
  },
];

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    let url;
    try { url = new URL(path, BASE); } catch (e) { resolveResult({ ok: false, error: e.message }); return; }
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
        agent,
        timeout: opts.timeoutMs || 60_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolveResult({
            ok: true,
            res: {
              status: res.statusCode,
              text: () => body.toString("utf8"),
              json: () => { try { return JSON.parse(body.toString("utf8")); } catch { return null; } },
            },
          });
        });
      }
    );
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) {
      if (typeof opts.body === "string") r.write(opts.body);
      else r.write(Buffer.from(opts.body));
    }
    r.end();
  });
}

async function waitReady(maxSec = 30) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req("/api/voice/status");
    if (r.ok && r.res.status === 200) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

const report = {
  timestamp: new Date().toISOString(),
  argosRoot: ARGOS_ROOT,
  port: PORT,
  queries: QUERIES,
  results: {},
};

let server = null;
console.log(`phase3-validation  ARGOS_ROOT=${ARGOS_ROOT}  port=${PORT}`);

try {
  console.log("\n[boot] starting next start on port " + PORT);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  if (!(await waitReady(30))) throw new Error("server did not become ready");
  console.log("[boot] ready");

  // === Auto-ingest the EKG seed corpus ===
  console.log("\n=== auto-ingest vault/raw/ ===");
  const ai = await req("/api/vault/auto-ingest", { method: "POST", timeoutMs: 300_000 });
  if (!ai.ok || ai.res.status !== 200) {
    throw new Error("auto-ingest failed: " + (ai.error || ai.res.status));
  }
  const aiJson = await ai.res.json();
  console.log(`  raw: ${aiJson.rawPath}`);
  console.log(`  legacy dropbox: ${aiJson.legacyDropboxPath}`);
  console.log(`  total: ${aiJson.totalFiles}  ingested: ${aiJson.ingested}  errored: ${aiJson.errored}  skipped: ${aiJson.skipped}`);
  for (const rec of aiJson.records) {
    if (rec.status === "ingested") {
      console.log(`    OK  [${rec.dropZone}] ${rec.filename}  → ${rec.chunkCount} chunks in ${rec.durationMs}ms`);
    } else {
      console.log(`    ERR [${rec.dropZone}] ${rec.filename}  → ${rec.error?.slice(0, 100)}`);
    }
  }
  report.autoIngest = aiJson;

  // === Vault list (sanity: total docs + chunks for the HUD) ===
  console.log("\n=== /api/vault/list ===");
  const lr = await req("/api/vault/list");
  if (lr.ok && lr.res.status === 200) {
    const lj = await lr.res.json();
    report.vaultList = { docs: lj.documents.length, totalChunks: lj.totalChunks };
    console.log(`  docs: ${lj.documents.length}  totalChunks: ${lj.totalChunks}`);
  }

  // === Run the 5 validation queries ===
  console.log("\n=== Validation queries ===");
  for (const q of QUERIES) {
    const r = await req(`/api/vault/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // v1.1 Task 5: topK matches Bart's persona config (5 → 8) so
      // the validation reflects what the chat dispatcher would inject.
      body: JSON.stringify({ query: q.q, topK: 8 }),
      timeoutMs: 60_000,
    });
    const out = { query: q.q, error: null, hits: [], confidenceBuckets: { high: 0, medium: 0, low: 0 } };
    if (!r.ok) {
      out.error = r.error;
    } else if (r.res.status !== 200) {
      out.error = `HTTP ${r.res.status}: ${(r.res.text() || "").slice(0, 200)}`;
    } else {
      const j = await r.res.json();
      out.hits = (j.hits || []).map((h) => ({
        filename: h.filename,
        chunkIndex: h.chunkIndex,
        score: h.score,
        confidence: h.confidence,
        textPreview: (h.text || "").replace(/\s+/g, " ").slice(0, 120),
      }));
      for (const h of out.hits) {
        if (h.confidence === "high") out.confidenceBuckets.high++;
        else if (h.confidence === "medium") out.confidenceBuckets.medium++;
        else if (h.confidence === "low") out.confidenceBuckets.low++;
      }
    }
    report.results[q.id] = out;

    console.log("");
    console.log(`${q.id}: "${q.q}"`);
    if (out.error) {
      console.log(`  ERROR: ${out.error}`);
    } else if (out.hits.length === 0) {
      console.log(`  (no hits above floor) — false-citation test: ${q.falseCitationTest ? "PASS" : "no expected sources matched"}`);
    } else {
      for (const h of out.hits) {
        const expected = q.expectedSources?.includes(h.filename);
        const tag = expected ? "✓" : " ";
        console.log(`  ${tag} [${h.confidence?.toUpperCase().padEnd(6)}] ${h.score.toFixed(3)}  ${h.filename}  chunk ${h.chunkIndex}`);
      }
      if (q.expectedSources?.length) {
        const got = new Set(out.hits.map((h) => h.filename));
        const matched = q.expectedSources.filter((src) => got.has(src));
        console.log(`  expected sources matched: ${matched.length}/${q.expectedSources.length}  (${matched.join(", ") || "none"})`);
      }
    }
  }

  // Pass-criteria summary
  console.log("\n=== Pass criteria ===");
  let pass = 0, fail = 0;
  for (const q of QUERIES) {
    const out = report.results[q.id];
    if (q.falseCitationTest) {
      const isPass = out.hits.length === 0;
      console.log(`  ${q.id} (false citation): ${isPass ? "PASS" : "FAIL — got " + out.hits.length + " hits"}`);
      isPass ? pass++ : fail++;
    } else if (q.expectedSources) {
      const got = new Set(out.hits.map((h) => h.filename));
      const matched = q.expectedSources.filter((src) => got.has(src));
      const isPass = matched.length >= 1;
      console.log(`  ${q.id}: ${isPass ? "PASS" : "FAIL"} (${matched.length}/${q.expectedSources.length} expected)`);
      isPass ? pass++ : fail++;
    }
  }
  report.passCount = pass;
  report.failCount = fail;
  console.log(`\n  totals: ${pass} pass, ${fail} fail`);

} catch (e) {
  console.log("\n[fatal] " + (e instanceof Error ? e.stack : String(e)));
  report.fatal = e instanceof Error ? e.message : String(e);
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
        setTimeout(() => { try { server.kill("SIGKILL"); } catch {} }, 2000);
      }
    } catch {}
  }
  agent.destroy();
}

await writeFile("phase3-validation.json", JSON.stringify(report, null, 2), "utf8");
console.log("\nWrote phase3-validation.json");
process.exit(report.failCount > 0 ? 1 : 0);
