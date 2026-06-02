#!/usr/bin/env node
// validate-web.mjs — Web Capability live validation runner (2026-06-02).
// Boots next start against a temp ARGOS_ROOT and runs the 5 directive
// validation queries through the real tools, printing honest results for
// WEB_TIER_VALIDATION.md. Not a smoke (no pass/fail) — an evidence collector.

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7860;
const ROOT = join(tmpdir(), `argos-validate-web-${process.pid}`);

function exec(base, toolId, params) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ toolId, params }));
    const url = new URL("/api/tools/execute", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { "content-type": "application/json", "content-length": body.length }, timeout: 90000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {} res(j); }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
    r.write(body); r.end();
  });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/web/stats", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000));
  } return false;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;

const line = (s) => console.log(s);
try {
  if (!(await ready(base))) throw new Error("server not ready");
  line("[ready] running 5 validation queries LIVE\n");

  line("## 1. \"Who is the CEO of Levi Strauss?\" → chain_search_to_read");
  const q1 = await exec(base, "chain_search_to_read", { query: "who is the CEO of Levi Strauss 2026", read: 3 });
  line(`engine=${q1?.result?.data?.engine} hits=${q1?.result?.data?.results?.length} read=${q1?.result?.data?.read?.filter?.((r)=>r.readOk).length} aggregated=${q1?.result?.data?.aggregated?.length} chars`);
  line(`top: ${q1?.result?.data?.results?.[0]?.title} — ${q1?.result?.data?.results?.[0]?.url}`);
  line(`excerpt: ${(q1?.result?.data?.aggregated ?? "").replace(/\s+/g, " ").slice(0, 280)}\n`);

  line("## 2. \"Latest arXiv papers on local LLM fine-tuning\" → arxiv_search (date sort)");
  const q2 = await exec(base, "arxiv_search", { query: "local LLM fine-tuning", maxResults: 5, sortByDate: true });
  for (const p of (q2?.result?.data?.papers ?? []).slice(0, 5)) line(`- ${p.published?.slice(0,10)} ${p.title} (${p.absUrl})`);
  line("");

  line("## 3. \"Current events in Florida today\" → gdelt_events");
  const q3 = await exec(base, "gdelt_events", { query: "Florida", timespan: "1d", maxResults: 5 });
  for (const a of (q3?.result?.data?.articles ?? []).slice(0, 5)) line(`- [${a.domain}] ${a.title} (${a.url})`);
  if (!(q3?.result?.data?.articles?.length)) line(`(gdelt: ${q3?.result?.error ?? "no articles"})`);
  line("");

  line("## 4. \"Top React state management libraries on GitHub\" → github_search");
  const q4 = await exec(base, "github_search", { mode: "repositories", query: "react state management stars:>5000", });
  for (const r of (q4?.result?.data?.results ?? []).slice(0, 5)) line(`- ${r.name} ★${r.stars} — ${r.description?.slice(0,80)}`);
  line(`(authed=${q4?.result?.data?.authed})\n`);

  line("## 5. \"Photosynthesis mechanism\" → wikipedia_search");
  const q5 = await exec(base, "wikipedia_search", { query: "Photosynthesis" });
  line(`title: ${q5?.result?.data?.title} (${q5?.result?.data?.url})`);
  line(`summary: ${(q5?.result?.data?.summary ?? "").slice(0, 280)}\n`);
} catch (e) {
  line(`[fatal] ${e.message}`);
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
