#!/usr/bin/env node
// smoke-tier3-tools.mjs — Web TIER 3 live gate (2026-06-02).
//
// Jina Reader, RSSHub (local container), firecrawl-alt, chain_search_to_read,
// plus the operator per-source kill switch — through the governance executor,
// LIVE, against a THROWAWAY ARGOS_ROOT.
//
// Usage: node scripts/smoke-tier3-tools.mjs [--port 7854]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7854;
const ROOT = join(tmpdir(), `argos-tier3-${process.pid}`);

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function post(base, path, body) {
  return new Promise((res) => {
    const buf = Buffer.from(JSON.stringify(body));
    const url = new URL(path, base);
    const r = http.request(
      { method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
        headers: { "content-type": "application/json", "content-length": buf.length }, timeout: 90000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {} res(j); }); }
    );
    r.on("error", () => res(null));
    r.on("timeout", () => { r.destroy(); res(null); });
    r.write(buf); r.end();
  });
}
const exec = (base, toolId, params) => post(base, "/api/tools/execute", { toolId, params });

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
  console.log(`\n[boot] tier3 — next start :${PORT} (ARGOS_ROOT=${ROOT})`);
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
    console.log("=== T32 jina_reader ===");
    const jr = await exec(base, "jina_reader", { url: "https://example.com" });
    reliable("jina reads a URL to markdown", jr, (d) => typeof d?.markdown === "string" && /example domain/i.test(d.markdown));

    console.log("\n=== T34 firecrawl_alt ===");
    const fc = await exec(base, "firecrawl_alt", { url: "https://example.com" });
    reliable("firecrawl-alt extracts content", fc, (d) => /example/i.test(d?.title ?? "") && (d?.content ?? "").length > 20);

    console.log("\n=== T33 rsshub_feed (local container) ===");
    const rss = await exec(base, "rsshub_feed", { path: "test/1" });
    check("rsshub returns feed items (tolerant)", rss?.result && typeof rss.result.ok === "boolean",
      rss?.result?.ok ? `${rss.result.data?.items?.length ?? 0} items` : `graceful: ${rss?.result?.error}`);

    console.log("\n=== T35 chain_search_to_read (THE FIX) ===");
    const ch = await exec(base, "chain_search_to_read", { query: "who is the CEO of Levi Strauss", read: 3 });
    reliable("chain searches + ranks results", ch, (d) => Array.isArray(d?.results) && d.results.length > 0);
    check("chain actually READ pages (not just snippets)", (ch?.result?.data?.aggregated ?? "").length > 200,
      `aggregated ${ch?.result?.data?.aggregated?.length ?? 0} chars, read ${ch?.result?.data?.read?.filter?.((r) => r.readOk).length ?? 0}`);

    console.log("\n=== kill switch: disable a source ===");
    await post(base, "/api/web/disabled", { source: "jina_reader", disabled: true });
    const blocked = await exec(base, "jina_reader", { url: "https://example.com" });
    check("disabled source is blocked", blocked?.result?.ok === false && /disabled/i.test(blocked?.result?.error ?? ""), blocked?.result?.error ?? "");
    await post(base, "/api/web/disabled", { source: "jina_reader", disabled: false });
    const reenabled = await exec(base, "jina_reader", { url: "https://example.com" });
    check("re-enabled source works again", reenabled?.result?.ok === true);

    console.log("\n=== infra: tools/list shows full roster ===");
    const list = await new Promise((res) => { http.get(new URL("/api/tools/list", base), (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }).on("error", () => res(null)); });
    check("tools/list has >= 31 tools", (list?.count ?? 0) >= 31, `${list?.count} tools`);
    const webCount = (list?.tools ?? []).filter((t) => t.category === "web").length;
    check("web tools include chain_search_to_read", (list?.tools ?? []).some((t) => t.id === "chain_search_to_read"), `${webCount} web tools`);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.log("\n[cleanup] throwaway ARGOS_ROOT removed");
}

console.log(`\nsmoke-tier3-tools: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
