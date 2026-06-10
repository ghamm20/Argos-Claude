#!/usr/bin/env node
// proof-phase4-proposer.mjs — Phase 4 gate proof (2026-06-10).
//
//   Gate 1: ≥3 DISTINCT proposal types in the queue from real workspace
//           context (research_brief via the >70% pre-fetch hook; file_op +
//           draft_document via workspace scans).
//   Gate 2: approve path EXECUTES with audit (proposal.applied + tool audit);
//           reject path DISCARDS with audit (proposal.rejected, action unrun).
//   Gate 3: ZERO autonomous execution — negative test: after generation,
//           no proposal action has touched disk and the tool-audit log is
//           empty of executions.
//   Doctrine: ReWOO top-3 predictions WITH probabilities; named reasoning
//           types on every prediction; predictions recorded as CLAIMS in the
//           verifier ledger; Brier calibration computed after ground truth
//           arrives; Rule 8 gate on the new surface (un-sessioned → 401).
//
// R1 COMPLIANCE (daemon-lifecycle doctrine): this harness never spawns,
// kills, or parents Ollama — it only talks to the daemon owned by the
// launcher supervisor. No watchdog park/resume is needed; the final check
// asserts the daemon is still healthy and unowned by this process.
//
// The observation corpus is built THROUGH THE REAL PIPELINE (operator chats
// against real Ollama) with an engineered dominant transition
// security|question → research_web|question so the pre-fetch hook fires
// deterministically (abductive 100% + temporal share → p≈0.84 > 0.70).
//
// Usage: node scripts/proof-phase4-proposer.mjs   (build first; Ollama up)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7924;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-phase4-${process.pid}`);
const MODEL_BART = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

function req(path, { method = "POST", body = null, headers = {}, timeoutMs = 300000 } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: timeoutMs },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ }
          res({ status: resp.statusCode, json: j, text }); }); });
    r.on("error", (e) => res({ status: 0, json: null, text: String(e) }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null, text: "timeout" }); });
    if (payload) r.write(payload); r.end();
  });
}
function chat(content, token, sessionId, history = []) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages: [...history, { role: "user", content }], personaId: "bartimaeus", model: MODEL_BART, useRetrieval: false, sessionId }));
    const u = new URL("/api/chat", BASE);
    let n = 0, status = 0;
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": body.length }, timeout: 300000 },
      (resp) => { status = resp.statusCode ?? 0; resp.on("data", (c) => { n += c.length; }); resp.on("end", () => res({ status, bytes: n })); });
    r.on("error", () => res({ status, bytes: n }));
    r.write(body); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (p) => {
  try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

// ---- workspace fixtures (REAL context for gate 1) ----
fs.mkdirSync(join(ROOT, "workspace"), { recursive: true });
fs.writeFileSync(join(ROOT, "workspace", "old-debug.tmp"), "stray temp file", "utf8");
fs.mkdirSync(join(ROOT, "tasks", "complete"), { recursive: true });
fs.writeFileSync(
  join(ROOT, "tasks", "complete", "t9-fixture-result.json"),
  JSON.stringify({ taskId: "t9-fixture", goal: "fixture overnight task", completedAt: new Date().toISOString(), summary: "1/1 step(s) succeeded", stepsPlanned: 1, stepsOk: 1, steps: [] }, null, 2),
  "utf8"
);

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  const PIN_HASH = hashPin("1234");
  await req("/api/settings", { body: { operatorPinHash: PIN_HASH, requirePin: true } });
  const v = await req("/api/auth/verify", { body: { pinHash: PIN_HASH } });
  const token = v.json?.token;
  if (!token) throw new Error("no session token");
  const bearer = { authorization: `Bearer ${token}` };

  // ---- build the corpus through the real pipeline ----
  console.log("=== Corpus build (engineered dominant transition) ===");
  const SEC = (s) => `Is the ${s} gate secure?`;                       // security|question
  const RES = (s) => `What is the latest news about ${s} hardening?`;  // research_web|question
  const turns = [
    { sess: "s1", text: SEC("audit") }, { sess: "s1", text: RES("encryption"), hist: [{ role: "user", content: SEC("audit") }, { role: "assistant", content: "Quite." }] },
    { sess: "s2", text: SEC("PIN") }, { sess: "s2", text: RES("firewall"), hist: [{ role: "user", content: SEC("PIN") }, { role: "assistant", content: "Yes." }] },
    { sess: "s3", text: SEC("session") }, { sess: "s3", text: RES("intrusion detection"), hist: [{ role: "user", content: SEC("session") }, { role: "assistant", content: "Yes." }] },
    { sess: "s4", text: SEC("runtime token") }, // ← tail: prediction target
  ];
  for (const t of turns) {
    // Retry transient 504s (cold-model first-token timeout) — the corpus
    // needs every turn captured; a retry is the operator re-sending.
    let c = await chat(t.text, token, t.sess, t.hist ?? []);
    for (let r = 0; r < 2 && c.status !== 200; r++) {
      await sleep(3000);
      c = await chat(t.text, token, t.sess, t.hist ?? []);
    }
    process.stdout.write(`  chat ${t.sess}: "${t.text.slice(0, 44)}…" → ${c.status}\n`);
  }
  await sleep(1500);
  const obs = readJsonl(join(ROOT, "state", "observation.jsonl"));
  check("corpus populated through the real pipeline", obs.length >= 7, `(${obs.length} entries)`);
  console.log(`  tail entry: ${JSON.stringify({ tc: obs[obs.length - 1]?.topic_class, qt: obs[obs.length - 1]?.query_type, sess: obs[obs.length - 1]?.session_id })}`);

  // ---- Rule 8 on the new surface ----
  console.log("\n=== Rule 8: proposals surface gated ===");
  const ungated = await req("/api/proposals", { method: "POST" });
  check("un-sessioned POST /api/proposals → 401", ungated.status === 401, `(status=${ungated.status})`);

  // ---- generation pass: ReWOO + pre-fetch + workspace scans ----
  console.log("\n=== Generation (ReWOO plan-ahead + >70% pre-fetch + workspace scans) ===");
  // Snapshot the tool-audit BEFORE generation: the corpus chats above
  // legitimately executed forced current-facts grounding (web_search) on the
  // CHAT path — gate 3 measures the DELTA across proposal generation only.
  const toolAuditBefore = readJsonl(join(ROOT, "state", "tool-audit.jsonl")).length;
  const gen = await req("/api/proposals", { method: "POST", headers: bearer, body: {} });
  check("generate 200", gen.status === 200);
  const preds = gen.json?.predictions ?? [];
  check("top-3 predictions WITH probabilities (ReWOO)", preds.length >= 1 && preds.length <= 3 && preds.every((p) => typeof p.probability === "number"), `(${preds.map((p) => `${p.topicClass}/${p.queryType}@${p.probability.toFixed(2)}`).join("; ")})`);
  const named = new Set(preds.flatMap((p) => p.reasoning));
  check("named reasoning types on predictions", ["probabilistic", "neuro-symbolic"].every((r) => named.has(r)) && (named.has("abductive") || named.has("analogical") || named.has("temporal")), `(${[...named].join(", ")})`);
  const top = preds[0];
  check("dominant prediction = research_web at p>0.70 (pre-fetch fires)", top?.topicClass === "research_web" && top.probability > 0.7, `(p=${top?.probability?.toFixed(3)})`);
  const created = gen.json?.created ?? [];
  const types = [...new Set(created.map((p) => p.type))].sort();
  check("gate 1: ≥3 DISTINCT proposal types created", types.length >= 3, `(${types.join(", ")})`);
  for (const p of created) console.log(`    proposal: [${p.type}] "${p.title}" conf=${p.confidence ?? "n/a"} via=${(p.reasoning ?? []).join("+")}`);

  // ---- gate 3: ZERO autonomous execution (negative test) ----
  console.log("\n=== Gate 3: zero autonomous execution ===");
  check("stray .tmp UNTOUCHED after generation", fs.existsSync(join(ROOT, "workspace", "old-debug.tmp")));
  const outputDocs = fs.existsSync(join(ROOT, "output")) ? fs.readdirSync(join(ROOT, "output")) : [];
  check("no digest doc generated", !outputDocs.some((n) => /overnight-digest/.test(n)), `(output/: ${outputDocs.length} files)`);
  const queueFiles = fs.readdirSync(join(ROOT, "tasks", "queue"), { recursive: false }).filter((n) => /^proposed-/.test(String(n)));
  check("no proposed task written to queue", queueFiles.length === 0);
  const toolAuditAfter = readJsonl(join(ROOT, "state", "tool-audit.jsonl")).length;
  check("tool-audit DELTA across generation is ZERO (no proposal action ran)", toolAuditAfter === toolAuditBefore, `(before=${toolAuditBefore} after=${toolAuditAfter})`);

  // ---- claims in the verifier ledger ----
  console.log("\n=== Predictions are CLAIMS ===");
  const ledger = readJsonl(join(ROOT, "state", "verifier", "ledger.jsonl"));
  const claims = ledger.filter((r) => r.rec === "claim" && r.source === "proposer.predict");
  check("verifier ledger has proposer.predict claims", claims.length >= preds.length, `(${claims.length} claims)`);
  if (claims.length) console.log(`  claim verbatim: ${JSON.stringify({ id: claims[0].id, assertion: claims[0].assertion })}`);

  // ---- gate 2: approve executes + audited; reject discards + audited ----
  console.log("\n=== Gate 2: approve / reject paths ===");
  const draft = created.find((p) => p.type === "draft_document");
  const fileOp = created.find((p) => p.type === "file_op");
  const approve = await req("/api/proposals/decide", { method: "POST", headers: bearer, body: { proposalId: draft?.id, decision: "approve" } });
  check("approve executes the action", approve.status === 200 && approve.json?.proposal?.status === "executed", `(status=${approve.json?.proposal?.status})`);
  const outputAfter = fs.existsSync(join(ROOT, "output")) ? fs.readdirSync(join(ROOT, "output")) : [];
  check("approved doc EXISTS on disk", outputAfter.some((n) => /overnight-digest/.test(n)), `(${outputAfter.join(", ")})`);
  const reject = await req("/api/proposals/decide", { method: "POST", headers: bearer, body: { proposalId: fileOp?.id, decision: "reject" } });
  check("reject discards unrun", reject.status === 200 && reject.json?.proposal?.status === "rejected");
  check("rejected target SURVIVES", fs.existsSync(join(ROOT, "workspace", "old-debug.tmp")));
  await sleep(300);
  const chain = readJsonl(join(ROOT, "state", "audit", "chain.jsonl"));
  check("audit: proposal.created entries", chain.filter((e) => e.kind === "proposal.created").length >= 3, `(${chain.filter((e) => e.kind === "proposal.created").length})`);
  check("audit: proposal.applied (ok) for the approval", chain.some((e) => e.kind === "proposal.applied" && e.payload?.ok === true));
  check("audit: proposal.rejected for the rejection", chain.some((e) => e.kind === "proposal.rejected"));

  // ---- Brier calibration after ground truth arrives ----
  console.log("\n=== Brier calibration (ground truth → outcomes) ===");
  // The operator's ACTUAL next ask — matches the dominant prediction (HIT).
  await chat(RES("VPN"), token, "s4", [{ role: "user", content: SEC("runtime token") }, { role: "assistant", content: "Yes." }]);
  await sleep(1500);
  const gen2 = await req("/api/proposals", { method: "POST", headers: bearer, body: { symbolicOnly: true } });
  const cal = gen2.json?.calibration ?? null;
  check("calibration computed", cal !== null && cal.n >= preds.length, `(n=${cal?.n}, hits=${cal?.hits})`);
  check("Brier score in [0,1]", typeof cal?.brier === "number" && cal.brier >= 0 && cal.brier <= 1, `(brier=${cal?.brier?.toFixed(4)})`);
  const ledger2 = readJsonl(join(ROOT, "state", "verifier", "ledger.jsonl"));
  const outcomes = ledger2.filter((r) => r.rec === "outcome");
  check("verifier outcomes recorded (predictions scored)", outcomes.length >= preds.length, `(${outcomes.length} outcomes)`);
  const verified = outcomes.filter((o) => o.verdict === "verified").length;
  check("dominant prediction VERIFIED against the actual ask", verified >= 1, `(${verified} verified / ${outcomes.length})`);
  if (outcomes.length) console.log(`  outcome verbatim: ${JSON.stringify({ claimId: outcomes[0].claimId, verdict: outcomes[0].verdict, evidence: outcomes[0].evidence })}`);

  // ---- chain integrity + R1 ----
  console.log("\n=== Chain integrity + R1 ===");
  const ver = spawnSync(process.execPath, [join(repoRoot, "scripts", "verify-audit-chain.mjs"), "--chain", join(ROOT, "state", "audit", "chain.jsonl")], { encoding: "utf8" });
  check("audit chain verifies end-to-end", ver.status === 0);
  const daemonUp = await (async () => { try { const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; } })();
  check("R1: daemon healthy and never owned by this harness", daemonUp);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase4-proposer: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
