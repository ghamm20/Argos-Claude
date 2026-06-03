#!/usr/bin/env node
// smoke-tool-integrity.mjs — the doctrine gate (v2.3.8).
//
// LAYER 1 (tool-tag parser hardening): the old parser required a literal
// <tool>...</tool> wrapper and silently rejected degraded openers, losing the
// call. Verifies the hardened parser accepts every variant (including the bare
// `{json}</tool>` that caused the MiroFish incident) and that EVERY failed
// parse is audited (never silently lost).
//
// LAYER 2 (model-integrity guard): verifies a turn that CLAIMS tool execution
// with no tool run is flagged (wouldWarn), and a legitimate turn is not.
//
// Deterministic — drives the pure parser + guard through /api/tools/parse-test
// (no dependence on what a model emits). Boots `next start` on a temp root so
// the tool-audit log is isolated.
//
// Usage: node scripts/smoke-tool-integrity.mjs [--port 7871]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7871;
const ROOT = join(tmpdir(), `argos-tool-integrity-${process.pid}`);

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function post(base, path, body) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const payload = Buffer.from(JSON.stringify(body));
    const r = http.request(
      { method: "POST", hostname: url.hostname, port: url.port, path: url.pathname,
        headers: { "content-type": "application/json", "content-length": payload.length }, timeout: 15000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }
    );
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
    r.write(payload); r.end();
  });
}
const parse = (base, text, opts = {}) => post(base, "/api/tools/parse-test", { text, ...opts });

async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000));
  } return false;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;
try {
  if (!(await ready(base))) throw new Error("server not ready");
  console.log("[ready] smoke-tool-integrity\n");

  console.log("=== LAYER 1 — parser accepts all tool-call openers ===");
  const canon = await parse(base, 'Let me check. <tool>{"id":"web_search","params":{"query":"x"}}</tool>');
  check("canonical <tool>{}</tool> → 1 call (web_search)", canon?.calls?.length === 1 && canon.calls[0].id === "web_search" && canon.failures.length === 0, JSON.stringify(canon?.calls));

  // THE BUG: bare JSON + </tool>, no opener at all (the MiroFish incident).
  const bug = await parse(base, 'On it.{"id":"mirofish_integration","params":{}}</tool>');
  check("BARE {json}</tool> → 1 call (mirofish_integration) — THE BUG", bug?.calls?.length === 1 && bug.calls[0].id === "mirofish_integration" && bug.failures.length === 0, JSON.stringify(bug?.calls));

  const gt = await parse(base, 'Sure. >{"id":"web_search","params":{"query":"x"}}</tool>');
  check("'>{json}</tool>' → 1 call", gt?.calls?.length === 1 && gt.calls[0].id === "web_search");

  const naked = await parse(base, '{"id":"open_meteo_weather","params":{"location":"Orlando"}}');
  check("bare known-tool JSON, no tags → 1 call", naked?.calls?.length === 1 && naked.calls[0].id === "open_meteo_weather");

  const nested = await parse(base, '{"id":"chain_search_to_read","params":{"query":"a {b} c","opts":{"deep":true}}}</tool>');
  check("nested params parsed (brace-aware)", nested?.calls?.length === 1 && nested.calls[0].params?.opts?.deep === true, JSON.stringify(nested?.calls?.[0]?.params));

  console.log("\n=== LAYER 1 — failed parses are NOT silent (audited) ===");
  const badjson = await parse(base, 'trying <tool>{"id":"web_search","params":{');
  check("truncated/invalid JSON → 0 calls, ≥1 failure", badjson?.calls?.length === 0 && badjson.failures.length >= 1, JSON.stringify(badjson?.failures));
  const unknown = await parse(base, '{"id":"not_a_real_tool","params":{}}</tool>');
  check("unknown tool id → 0 calls, 1 failure", unknown?.calls?.length === 0 && unknown.failures.length === 1 && /unknown tool/i.test(unknown.failures[0].reason), JSON.stringify(unknown?.failures));
  const legit = await parse(base, 'The config is {"name":"argos","port":7842}.');
  check("legit non-tool JSON → 0 calls, 0 failures (no false positive)", legit?.calls?.length === 0 && legit.failures.length === 0, JSON.stringify(legit));

  // Audit persistence: log a failure, then read the isolated tool-audit log.
  const logged = await parse(base, '{"id":"not_a_real_tool","params":{"x":1}}</tool>', { logAudit: true });
  check("parse-test reports audited >= 1", (logged?.audited ?? 0) >= 1, `audited=${logged?.audited}`);
  await new Promise((r) => setTimeout(r, 300));
  let auditLines = [];
  try { auditLines = fs.readFileSync(join(ROOT, "state", "tool-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* */ }
  const parseFailEntry = auditLines.find((e) => e.event === "parse_failed" && /not_a_real_tool/.test(e.toolId || "" + (e.rawText || "")));
  check("parse_failed entry persisted in tool-audit.jsonl", !!parseFailEntry, parseFailEntry ? `reason="${parseFailEntry.error}"` : "(no entry)");

  console.log("\n=== LAYER 2 — integrity guard flags fabricated tool use ===");
  const fab = await parse(base, "Yes, the tool was invoked and the simulation ran successfully.", { toolRan: false });
  check("false claim + no tool ran → wouldWarn", fab?.claimsToolUse === true && fab?.wouldWarn === true, JSON.stringify({ c: fab?.claimsToolUse, w: fab?.wouldWarn }));
  const fabRan = await parse(base, "Yes, the tool was invoked and the simulation ran successfully.", { toolRan: true });
  check("same claim but a tool DID run → no warning", fabRan?.wouldWarn === false);
  const attrib = await parse(base, "MiroFish returned three active entities near the perimeter.", { toolRan: false });
  check("named-system result attribution flagged", attrib?.claimsToolUse === true && attrib?.wouldWarn === true);
  const clean = await parse(base, "Here is the answer to your question, stated plainly.", { toolRan: false });
  check("ordinary answer → no claim, no warning", clean?.claimsToolUse === false && clean?.wouldWarn === false);
  const advice = await parse(base, "You could use the mirofish tool if you want to check the simulation.", { toolRan: false });
  check("offering a tool (not claiming use) → no warning", advice?.wouldWarn === false, JSON.stringify({ c: advice?.claimsToolUse }));
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nsmoke-tool-integrity: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
