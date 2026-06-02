#!/usr/bin/env node
// smoke-tier1-tools.mjs — Web TIER 1 live gate (2026-06-02).
//
// Executes the 9 keyless knowledge tools through the governance executor
// (/api/tools/execute) against a THROWAWAY ARGOS_ROOT, with LIVE internet.
// Verifies real results, cache reuse, and audit logging.
//
// Tolerance: 7 reliable sources are asserted strictly (ok+data); 2 flakier
// public APIs (Papers With Code, GDELT) pass on either real results OR a
// graceful degrade (the tool ran through governance without throwing).
//
// Usage: node scripts/smoke-tier1-tools.mjs [--port 7852]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7852;
const ROOT = join(tmpdir(), `argos-tier1-${process.pid}`);

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function exec(base, toolId, params) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ toolId, params }));
    const url = new URL("/api/tools/execute", base);
    const r = http.request(
      { method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
        headers: { "content-type": "application/json", "content-length": body.length }, timeout: 60000 },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
          res(json);
        });
      }
    );
    r.on("error", () => res(null));
    r.on("timeout", () => { r.destroy(); res(null); });
    r.write(body); r.end();
  });
}

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await new Promise((res) => {
      http.get(new URL("/api/web/stats", base), (resp) => { resp.resume(); res(resp.statusCode); }).on("error", () => res(0));
    });
    if (r === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(fn) {
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`\n[boot] tier1 — next start :${PORT} (ARGOS_ROOT=${ROOT})`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready (LIVE internet calls follow)\n");
    await fn(base);
  } finally {
    try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  }
}

const reliable = (label, r, test) => {
  const ok = r?.ok === true && r?.result?.ok === true;
  check(label, ok && test(r.result.data), ok ? "" : `(${r?.result?.error ?? "no response"})`);
};
const tolerant = (label, r) => {
  // pass if it produced real results OR degraded gracefully (ran, returned a result)
  const ran = r?.result && typeof r.result.ok === "boolean";
  check(`${label} (tolerant)`, ran, r?.result?.ok ? "ok" : `graceful: ${r?.result?.error ?? "no response"}`);
};

try {
  await withServer(async (base) => {
    console.log("=== T19 wikipedia ===");
    const w1 = await exec(base, "wikipedia_search", { query: "Photosynthesis" });
    reliable("wikipedia returns article", w1, (d) => /photosynthesis/i.test(d?.title ?? "") && (d?.fullText ?? "").length > 100);
    const w2 = await exec(base, "wikipedia_search", { query: "Photosynthesis" });
    check("wikipedia 2nd call served from cache", w2?.result?.data?.fromCache === true, String(w2?.result?.data?.fromCache));

    console.log("\n=== T20 wikidata ===");
    const wd = await exec(base, "wikidata_query", { query: "Douglas Adams" });
    reliable("wikidata resolves entity", wd, (d) => /adams/i.test(d?.label ?? "") && (d?.id ?? "").startsWith("Q"));

    console.log("\n=== T21 arxiv ===");
    const ax = await exec(base, "arxiv_search", { query: "large language models", maxResults: 5 });
    reliable("arxiv returns papers", ax, (d) => Array.isArray(d?.papers) && d.papers.length > 0 && d.papers[0].title);

    console.log("\n=== T22 openalex ===");
    const oa = await exec(base, "openalex_search", { query: "retrieval augmented generation" });
    reliable("openalex returns works", oa, (d) => Array.isArray(d?.works) && d.works.length > 0);

    console.log("\n=== T23 papers_with_code ===");
    tolerant("papers_with_code", await exec(base, "papers_with_code", { query: "image classification" }));

    console.log("\n=== T24 huggingface ===");
    const hf = await exec(base, "huggingface_hub", { query: "llama" });
    reliable("huggingface returns models", hf, (d) => Array.isArray(d?.results) && d.results.length > 0 && d.results[0].id);

    console.log("\n=== T25 crossref ===");
    const cr = await exec(base, "crossref_lookup", { query: "attention is all you need" });
    reliable("crossref returns metadata", cr, (d) => Array.isArray(d?.results) && d.results.length > 0 && d.results[0].title);

    console.log("\n=== T26 pubmed ===");
    const pm = await exec(base, "pubmed_search", { query: "CRISPR gene editing" });
    reliable("pubmed returns papers", pm, (d) => Array.isArray(d?.papers) && d.papers.length > 0 && d.papers[0].pmid);

    console.log("\n=== T27 gdelt ===");
    tolerant("gdelt", await exec(base, "gdelt_events", { query: "technology", timespan: "1d" }));

    console.log("\n=== infra: audit log written ===");
    const auditFile = join(ROOT, "state", "web-audit.jsonl");
    const lines = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean) : [];
    check("web-audit.jsonl has entries", lines.length >= 9, `${lines.length} entries`);
    const sources = new Set(lines.map((l) => { try { return JSON.parse(l).source; } catch { return ""; } }));
    check("audit covers multiple sources", sources.size >= 6, `${sources.size} sources`);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
  console.log("\n[cleanup] throwaway ARGOS_ROOT removed");
}

console.log(`\nsmoke-tier1-tools: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
