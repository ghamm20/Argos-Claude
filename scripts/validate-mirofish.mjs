#!/usr/bin/env node
// validate-mirofish.mjs (v2.3.10) — proves the mirofish_integration tool hits
// the REAL MiroFish-Offline backend (Flask API on :5001) with REAL endpoints,
// returns real data when up, and reports honest, specific errors otherwise —
// never the old blanket "MiroFish not running. Start it on port 3001."
//
// The old tool hit :3001 (the Vite UI) /api/simulation/status + /api/entities,
// which 404. Correct surface: :5001 /health, /api/simulation/list,
// /api/graph/project/list, /api/simulation/entities/<graph_id>.
//
// Boots `next start` on a throwaway ARGOS_ROOT (so tool-audit.jsonl is fresh).
// Probes MiroFish directly first: if up → asserts real data; if down → asserts
// the honest connection-refused error (NOT "not running"). Tests:
//   A  execute→approve default snapshot → ok:true, connected:true, real summary
//   B  endpoint passthrough /api/simulation/list → ok:true with count
//   C  bad endpoint /api/nope → ok:false, error names the 404 (honest)
//   D  tool-audit.jsonl last mirofish entry ok:true
//   E  LIVE Bart: chat → tool_approval_required → approve → connected:true
// Usage: node scripts/validate-mirofish.mjs [--port 7877]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";
import { runtimeTokenHeader } from "./lib/runtime-token.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7877;
const ROOT = join(tmpdir(), `argos-mirofish-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";
const MIROFISH = "http://127.0.0.1:5001";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [PASS] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function postJson(base, path, payload, timeout = 20000) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const body = Buffer.from(JSON.stringify(payload));
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "content-type": "application/json", ...runtimeTokenHeader(ROOT), "content-length": body.length }, timeout },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch { res(null); } }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); }); r.write(body); r.end();
  });
}
function getRaw(url, timeout = 6000) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = http.request({ method: "GET", hostname: u.hostname, port: u.port, path: u.pathname, timeout }, (resp) => {
      const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => res({ status: resp.statusCode, text: Buffer.concat(c).toString("utf8") }));
    });
    r.on("error", () => res({ status: 0, text: "" })); r.on("timeout", () => { r.destroy(); res({ status: 0, text: "" }); }); r.end();
  });
}
// Run an approval-gated tool: execute → approve. Returns the final ToolResult.
async function runTool(base, params) {
  const ex = await postJson(base, "/api/tools/execute", { toolId: "mirofish_integration", params });
  if (!ex?.approvalRequired || !ex.approvalId) return { _execError: ex };
  const ap = await postJson(base, "/api/tools/approve", { approvalId: ex.approvalId, decision: "approve" });
  return ap?.result ?? { _approveError: ap };
}
// Live Bart: send a chat asking for the tool, capture the approvalId from the
// stream, approve it, return the tool result.
function chatForApproval(base, content) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }], personaId: "bartimaeus", model: MODEL, useRetrieval: false, truthMode: false }));
    const url = new URL("/api/chat", base);
    const r = http.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "content-type": "application/json", "content-length": body.length }, timeout: 180000 }, (resp) => {
      let buf = "", approvalId = null, text = "";
      resp.on("data", (c) => { buf += c.toString("utf8"); let nl; while ((nl = buf.indexOf("\n")) !== -1) { const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!ln) continue; try { const j = JSON.parse(ln); if (j?.message?.content) text += j.message.content; if (j?.type === "tool_approval_required") approvalId = j.approvalId; } catch { /* */ } } });
      resp.on("end", () => res({ approvalId, text: text.trim() }));
    });
    r.on("error", () => res({ approvalId: null, text: "[error]" })); r.on("timeout", () => { r.destroy(); res({ approvalId: null, text: "[timeout]" }); });
    r.write(body); r.end();
  });
}
async function ready(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) { const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await new Promise((rs) => setTimeout(rs, 1000)); } return false;
}

const NOT_RUNNING_RE = /not running|start it on port 3001/i;

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
const base = `http://127.0.0.1:${PORT}`;

try {
  // Is MiroFish actually up? Probe its backend directly.
  const mfHealth = await getRaw(`${MIROFISH}/health`);
  const mfUp = mfHealth.status === 200 && /ok/i.test(mfHealth.text);
  console.log(`[probe] MiroFish ${MIROFISH}/health → ${mfHealth.status}${mfUp ? " (UP)" : " (DOWN)"}\n`);

  if (!(await ready(base))) throw new Error("ARGOS server not ready");
  console.log("[ready] validate-mirofish\n");

  console.log("=== Test A — default snapshot (execute → approve) ===");
  const a = await runTool(base, { query: "status" });
  console.log(`A: ok=${a?.ok} summary="${(a?.summary ?? "").slice(0, 160)}"`);
  if (mfUp) {
    check("A: tool ok:true", a?.ok === true, JSON.stringify(a?.error ?? null));
    check("A: data.connected:true", a?.data?.connected === true);
    check("A: summary is real (no 'not running' / port 3001)", !NOT_RUNNING_RE.test(a?.summary ?? ""), `"${a?.summary}"`);
    check("A: summary says 'online' + reports simulations", /online/i.test(a?.summary ?? "") && /simulation/i.test(a?.summary ?? ""));
    check("A: base is :5001 (not :3001)", typeof a?.data?.base === "string" && a.data.base.includes(":5001"), a?.data?.base);
    // Entity-count fidelity: the snapshot must not under-report vs the sim
    // record's own entities_count (the empty-detail-bundle flake bug).
    const sim0 = a?.data?.simulations?.items?.[0];
    if (sim0 && typeof sim0.entities_count === "number" && sim0.entities_count > 0) {
      check("A: entity count matches the simulation record (not under-reported)", a?.data?.entities?.count === sim0.entities_count, `sim says ${sim0.entities_count}, entities.count=${a?.data?.entities?.count}`);
      check("A: summary reflects the real entity count (never '0 entities' when sim has entities)", new RegExp(`${sim0.entities_count} entit`).test(a?.summary ?? "") && !/: 0 entit/.test(a?.summary ?? ""), a?.summary);
    } else {
      console.log("  [note] active simulation reports 0 entities — count-fidelity assertion skipped (no entities to verify)");
    }
  } else {
    check("A (MiroFish down): ok:false honest connection-refused — NOT 'not running'", a?.ok === false && /connection refused|not reachable/i.test(a?.error ?? "") && !/start it on port 3001/i.test(a?.error ?? ""), JSON.stringify(a?.error));
  }

  console.log("\n=== Test B — endpoint passthrough /api/simulation/list ===");
  const b = await runTool(base, { endpoint: "/api/simulation/list" });
  console.log(`B: ok=${b?.ok} summary="${(b?.summary ?? "").slice(0, 120)}"`);
  if (mfUp) {
    check("B: passthrough ok:true", b?.ok === true, JSON.stringify(b?.error ?? null));
    check("B: returns the real list envelope (has count)", b?.data?.result && typeof b.data.result.count === "number", JSON.stringify(b?.data?.result ?? null).slice(0, 120));
  } else {
    check("B (down): honest refused error", b?.ok === false && /connection refused|not reachable/i.test(b?.error ?? ""));
  }

  console.log("\n=== Test C — bad endpoint → honest 404 (not 'not running') ===");
  const c = await runTool(base, { endpoint: "/api/this-does-not-exist" });
  console.log(`C: ok=${c?.ok} error="${c?.error ?? ""}"`);
  if (mfUp) {
    check("C: ok:false", c?.ok === false);
    check("C: error names the HTTP 404 (endpoint error), not 'not running'", /404/.test(c?.error ?? "") && !NOT_RUNNING_RE.test(c?.error ?? ""), `"${c?.error}"`);
  } else {
    check("C (down): honest refused error", c?.ok === false && /connection refused|not reachable/i.test(c?.error ?? ""));
  }

  console.log("\n=== Test D — tool-audit.jsonl reflects the real outcome ===");
  await new Promise((r) => setTimeout(r, 300));
  let audits = [];
  try { audits = fs.readFileSync(join(ROOT, "state", "tool-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.toolId === "mirofish_integration" && e.event !== "parse_failed"); } catch { /* */ }
  const lastA = audits[audits.length - 1] ?? null;
  console.log(`D: ${audits.length} mirofish audit entries; last: ok=${lastA?.ok} "${(lastA?.summary ?? "").slice(0, 120)}"`);
  if (mfUp) {
    // A real snapshot (Test A/B) audited ok:true. Note: the LAST entry is Test C's
    // intentional 404 (ok:false by design) — so assert an ok:true entry EXISTS,
    // not that the last one is. The honest-error entries are correct, not stale.
    check("D: a real-snapshot audit entry is ok:true", audits.some((e) => e.ok === true && /online/i.test(e.summary ?? "")), `${audits.filter((e) => e.ok).length}/${audits.length} ok`);
    check("D: NO audit entry carries the stale 'not running' / port 3001", audits.every((e) => !NOT_RUNNING_RE.test(e.summary ?? "")));
  } else {
    check("D: audit recorded (ok:false honest)", lastA && lastA.ok === false);
  }

  console.log("\n=== Test E — LIVE Bart: chat → approval → approve → real data ===");
  const e = await chatForApproval(base, "Bartimaeus, run a MiroFish test for me. Use the mirofish_integration tool to query the simulation status.");
  console.log(`E: bart="${e.text.slice(0, 160)}"  approvalId=${e.approvalId ? "yes" : "no"}`);
  if (e.approvalId) {
    const approved = await postJson(base, "/api/tools/approve", { approvalId: e.approvalId, decision: "approve" });
    const r = approved?.result;
    console.log(`E: approved result ok=${r?.ok} connected=${r?.data?.connected} summary="${(r?.summary ?? "").slice(0, 140)}"`);
    if (mfUp) {
      check("E: Bart's tool call ran against real MiroFish (connected:true)", r?.ok === true && r?.data?.connected === true, JSON.stringify(r?.error ?? null));
      check("E: result not the stale 'not running'", !NOT_RUNNING_RE.test(r?.summary ?? ""));
    } else {
      check("E (down): honest refused error surfaced", r?.ok === false && /connection refused|not reachable/i.test(r?.error ?? ""));
    }
  } else {
    // Bart didn't emit the tool call this run (model stochasticity). Not a tool
    // bug — but surface it honestly rather than passing vacuously.
    check("E: Bart emitted the mirofish tool call (approval requested)", false, "no tool_approval_required event — re-run; model did not call the tool this turn");
  }
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\nvalidate-mirofish: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
