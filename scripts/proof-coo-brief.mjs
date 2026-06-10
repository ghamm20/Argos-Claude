#!/usr/bin/env node
// proof-coo-brief.mjs (Stage 13, 2026-06-09) — the COO brief.
//   Run 1 (synthetic mailbox): inbox bucketed (escalation/decision/financial),
//     action queue built, brief written, brief.coo_generated audited.
//   Run 2 (no token): inbox section DEFERRED with email_gate_deferred; the brief
//     still ships (tasks-only).
// Usage: node scripts/proof-coo-brief.mjs [--port 7905]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7905;

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
function post(base, path) { return new Promise((res) => { const u = new URL(path, base); const r = http.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", "content-length": 2 }, timeout: 30000 }, (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); }); r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); r.write("{}"); r.end(); }); }
async function ready(base, maxSec = 60) { for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false; }
function audit(root, kind) { try { return fs.readFileSync(join(root, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } }
async function runServer(port, root, env) { fs.mkdirSync(root, { recursive: true }); const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: root, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); server.stdout.on("data", () => {}); server.stderr.on("data", () => {}); const base = `http://127.0.0.1:${port}`; if (!(await ready(base))) { server.kill("SIGKILL"); throw new Error("server not ready"); } return { server, base }; }
function kill(server) { try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ } }

const ROOT1 = join(tmpdir(), `argos-coo-${process.pid}`);
const ROOT2 = join(tmpdir(), `argos-coo-def-${process.pid}`);
const FIX = join(ROOT1, "fixtures.json");
fs.mkdirSync(ROOT1, { recursive: true });
fs.writeFileSync(FIX, JSON.stringify([
  { id: "e1", from: "ops@ekg.test", subject: "URGENT: production outage escalation", snippet: "down", body: "Service is down, escalate now." },
  { id: "d1", from: "legal@ekg.test", subject: "Please sign and approve the MSA", snippet: "sign", body: "Authorize the master agreement." },
  { id: "f1", from: "billing@vendor.test", subject: "Invoice #4012 due — renewal", snippet: "invoice", body: "Payment for the annual renewal." },
  { id: "x1", from: "news@promo.test", subject: "Weekly digest", snippet: "fyi", body: "Some updates." },
]), "utf8");

try {
  console.log("=== Run 1: synthetic mailbox → COO brief ===");
  const s1 = await runServer(PORT, ROOT1, { ARGOS_EMAIL_FIXTURES: FIX });
  const r1 = await post(s1.base, "/api/brief/coo");
  console.log(`  buckets: ${JSON.stringify(Object.fromEntries(Object.entries(r1?.buckets ?? {}).map(([k, v]) => [k, v.length])))}`);
  check("escalation bucketed", r1?.buckets?.escalation?.length === 1);
  check("decision bucketed", r1?.buckets?.decision?.length === 1);
  check("financial bucketed", r1?.buckets?.financial?.length === 1);
  const brief = fs.existsSync(r1.briefPath) ? fs.readFileSync(r1.briefPath, "utf8") : "";
  check("COO brief written", brief.length > 0);
  check("brief has a recommended action queue", /Recommended action queue/.test(brief) && /1\. URGENT: production outage/.test(brief));
  check("brief.coo_generated audited", audit(ROOT1, "brief.coo_generated").length >= 1);
  kill(s1.server);

  console.log("\n=== Run 2: no token → inbox DEFERRED, brief still ships ===");
  const s2 = await runServer(PORT + 1, ROOT2, {});
  const r2 = await post(s2.base, "/api/brief/coo");
  check("inbox deferred (email_gate_deferred)", r2?.deferred === "email_gate_deferred");
  check("email_gate_deferred audited", audit(ROOT2, "email_gate_deferred").some((e) => e.payload?.stage === "coo_brief"));
  check("brief still written (tasks-only)", fs.existsSync(r2.briefPath));
  kill(s2.server);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { fs.rmSync(ROOT1, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-coo-brief: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
