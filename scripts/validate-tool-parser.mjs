#!/usr/bin/env node
// validate-tool-parser.mjs (v2.3.8 doctrine) — the tool-tag parser must recover
// EVERY malformed-but-valid variant the model emits, and never silently drop a
// tool-shaped emission.
//
// Drives the pure parser via /api/tools/parse-test (deterministic) on a throwaway
// ARGOS_ROOT so the tool-audit log is isolated.
//
// Usage: node scripts/validate-tool-parser.mjs [--port 7873]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7873;
const ROOT = join(tmpdir(), `argos-tool-parser-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function parse(base, text, opts = {}) {
  return new Promise((res) => {
    const url = new URL("/api/tools/parse-test", base);
    const payload = Buffer.from(JSON.stringify({ text, ...opts }));
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "content-type": "application/json", "content-length": payload.length }, timeout: 15000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); r.write(payload); r.end();
  });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] validate-tool-parser\n");

  console.log("=== all four opener variants MUST be detected + executable ===");
  const VARIANTS = [
    ['bare {json}</tool>', '{"id":"web_search","params":{"q":"test"}}</tool>'],
    ['<tool>{json}</tool>', '<tool>{"id":"web_search","params":{"q":"test"}}</tool>'],
    ["'>{json}</tool>'", '>{"id":"web_search","params":{"q":"test"}}</tool>'],
    ['garbage text {json}</tool>', 'I will now run a search. blah blah {"id":"web_search","params":{"q":"test"}}</tool>'],
  ];
  for (const [label, text] of VARIANTS) {
    const r = await parse(base, text);
    check(`${label} → 1 call (web_search), 0 failures`, r?.calls?.length === 1 && r.calls[0].id === "web_search" && r.failures.length === 0, JSON.stringify(r?.calls?.[0] ?? r?.failures));
  }

  console.log("\n=== a malformed attempt MUST be audited, never silently dropped ===");
  const before = (() => { try { return fs.readFileSync(join(ROOT, "state", "tool-audit.jsonl"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })();
  const bad = await parse(base, 'attempting <tool>{"id":"web_search","params":{', { logAudit: true });
  check("malformed JSON → 0 calls, ≥1 failure", bad?.calls?.length === 0 && bad.failures.length >= 1, JSON.stringify(bad?.failures));
  check("parse-test logged the failure (audited ≥ 1)", (bad?.audited ?? 0) >= 1, `audited=${bad?.audited}`);
  await new Promise((r) => setTimeout(r, 300));
  let lines = []; try { lines = fs.readFileSync(join(ROOT, "state", "tool-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* */ }
  check("tool-audit.jsonl grew with a parse_failed entry", lines.length > before && lines.some((e) => e.event === "parse_failed"), `before=${before} after=${lines.length}`);

  console.log("\n=== unknown tool id is flagged (attempted_unknown_tool) ===");
  const unk = await parse(base, '{"id":"a_tool_that_doesnt_exist","params":{}}</tool>');
  check("unknown tool → 0 calls, 1 failure (unknown tool id)", unk?.calls?.length === 0 && unk.failures.length === 1 && /unknown tool/i.test(unk.failures[0].reason), JSON.stringify(unk?.failures));
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\nvalidate-tool-parser: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
