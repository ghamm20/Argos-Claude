#!/usr/bin/env node
// smoke-tier2-tools.mjs — Web TIER 2 live gate (2026-06-02).
//
// Executes SearXNG, GitHub, Stack Exchange, SEC EDGAR through the governance
// executor against a THROWAWAY ARGOS_ROOT, LIVE.
//   - SearXNG: returns results from the local instance OR the DDG fallback
//   - GitHub: works keyless (60/hr) for repo search + README read
//   - Stack Exchange: returns Q&A
//   - SEC EDGAR: company submissions by CIK (reliable) + full-text (tolerant)
//
// Usage: node scripts/smoke-tier2-tools.mjs [--port 7853]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7853;
const ROOT = join(tmpdir(), `argos-tier2-${process.pid}`);

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
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {} res(j); }); }
    );
    r.on("error", () => res(null));
    r.on("timeout", () => { r.destroy(); res(null); });
    r.write(body); r.end();
  });
}

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/web/stats", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(fn) {
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`\n[boot] tier2 — next start :${PORT} (ARGOS_ROOT=${ROOT})`);
  const server = spawn(process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready (LIVE)\n");
    await fn(base);
  } finally {
    try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch {}
  }
}

const reliable = (label, r, test) => {
  const ok = r?.ok === true && r?.result?.ok === true;
  check(label, ok && test(r.result.data), ok ? "" : `(${r?.result?.error ?? "no response"})`);
};

try {
  await withServer(async (base) => {
    console.log("=== T28 searxng (or DDG fallback) ===");
    const sx = await exec(base, "searxng_search", { query: "artificial intelligence" });
    reliable("searxng returns results", sx, (d) => Array.isArray(d?.results) && d.results.length > 0 && d.results[0].url);
    if (sx?.result?.data?.engine) console.log(`       engine: ${sx.result.data.engine}`);

    console.log("\n=== T29 github (keyless) ===");
    const gh = await exec(base, "github_search", { mode: "repositories", query: "react state management stars:>5000" });
    reliable("github repo search", gh, (d) => Array.isArray(d?.results) && d.results.length > 0 && d.results[0].name);
    const rd = await exec(base, "github_search", { mode: "readme", owner: "facebook", repo: "react" });
    reliable("github README read", rd, (d) => typeof d?.readme === "string" && /react/i.test(d.readme));
    const rd2 = await exec(base, "github_search", { mode: "readme", owner: "facebook", repo: "react" });
    check("github 2nd README served from cache", rd2?.result?.data?.fromCache === true, String(rd2?.result?.data?.fromCache));

    console.log("\n=== T30 stackexchange ===");
    const se = await exec(base, "stackexchange_search", { query: "async await javascript" });
    reliable("stackexchange returns Q&A", se, (d) => Array.isArray(d?.results) && d.results.length > 0 && d.results[0].title);

    console.log("\n=== T31 sec_edgar ===");
    const sec = await exec(base, "sec_edgar", { cik: "320193" }); // Apple Inc.
    reliable("sec_edgar submissions by CIK", sec, (d) => /apple/i.test(d?.name ?? "") && Array.isArray(d?.filings) && d.filings.length > 0);
    const fts = await exec(base, "sec_edgar", { query: "Tesla" });
    check("sec_edgar full-text (tolerant)", fts?.result && typeof fts.result.ok === "boolean", fts?.result?.ok ? "ok" : `graceful: ${fts?.result?.error}`);

    console.log("\n=== infra: audit ===");
    const auditFile = join(ROOT, "state", "web-audit.jsonl");
    const lines = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean) : [];
    const sources = new Set(lines.map((l) => { try { return JSON.parse(l).source; } catch { return ""; } }));
    check("audit covers tier-2 sources", ["github", "stackexchange", "sec_edgar"].every((s) => sources.has(s)), [...sources].join(","));
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.log("\n[cleanup] throwaway ARGOS_ROOT removed");
}

console.log(`\nsmoke-tier2-tools: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
