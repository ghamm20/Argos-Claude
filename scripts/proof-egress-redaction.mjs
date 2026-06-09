#!/usr/bin/env node
// proof-egress-redaction.mjs (Gate 2, 2026-06-09) — live proof that a
// "redacted" Nous turn strips local-data system segments before the cloud call,
// and that "full" does not.
//
// Throwaway ARGOS_ROOT + real next-start server (same harness as the validate
// scripts). A persona is put on the Nous backend with a PLACEHOLDER api key —
// the egress redaction + audit happen BEFORE callNous (upstream of the network),
// so the proof needs no valid key and no real secret enters the repo. The
// cloud call then simply falls back to local; the redaction already happened.
//
// We force a SENSITIVE segment deterministically by sending a prior assistant
// turn that carries toolResults (→ buildRecentToolResultsBlock → label
// "tool_results:prior", sensitive). The proof reads the resulting
// chat.egress_redaction audit entry and asserts:
//   - labels_stripped contains the sensitive segment(s)
//   - labels_kept contains persona:identity and NO sensitive label
//   - a follow-up turn with cloudDataPolicy "full" writes NO redaction entry
//
// Usage: node scripts/proof-egress-redaction.mjs [--port 7892]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7892;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-egress-${process.pid}`);
const BART_MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); }
  else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); }
};

function reqJson(method, path, body) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...(payload ? { "content-length": payload.length } : {}) }, timeout: 60000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => res({ status: resp.statusCode, text: Buffer.concat(c).toString("utf8") })); });
    r.on("error", () => res({ status: 0, text: "" }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, text: "" }); });
    if (payload) r.write(payload); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => {
      http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false));
    });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}
function readAudit(kind) {
  try {
    return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.kind === kind);
  } catch { return []; }
}

// A prior assistant turn carrying a tool result → forces the sensitive
// "tool_results:prior" system segment on the next turn.
const HISTORY = [
  { role: "user", content: "Read my private notes file." },
  {
    role: "assistant",
    content: "Done.",
    toolResults: [
      { ok: true, toolId: "file_ops",
        summary: "read 4211 chars from workspace/private-notes.txt",
        data: { path: "workspace/private-notes.txt", content: "CONFIDENTIAL_LOCAL_DATA_xyz" } },
    ],
  },
  // Benign follow-up: must NOT trigger isExplicitToolRequest (no use/run/tool
  // words) or current-facts grounding — so the turn takes the plain Nous path.
  { role: "user", content: "Briefly restate the prior result in one sentence." },
];

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(
  process.execPath,
  [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
);
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log("[ready] proof-egress-redaction\n");

  // Configure: Bart → Nous backend, placeholder key (redaction is upstream of
  // the network call). cloudDataPolicy defaults to redacted (absent).
  const cfg = await reqJson("POST", "/api/settings", {
    perPersonaBackend: { bartimaeus: "nous" },
    nousApiKey: "sk-nous-PLACEHOLDER-redaction-is-upstream-of-network",
  });
  check("settings configured (Bart → Nous, key set)", cfg.status === 200, `status=${cfg.status}`);

  console.log("\n=== A) REDACTED policy (default) — sensitive segment must be stripped ===");
  const before = readAudit("chat.egress_redaction").length;
  const turn1 = await reqJson("POST", "/api/chat", {
    personaId: "bartimaeus", model: BART_MODEL, messages: HISTORY,
  });
  check("chat turn accepted (streamed)", turn1.status === 200, `status=${turn1.status}`);
  await new Promise((r) => setTimeout(r, 500));

  const redactions = readAudit("chat.egress_redaction");
  check("a chat.egress_redaction audit entry was written", redactions.length === before + 1,
    `before=${before} after=${redactions.length}`);
  const e = redactions[redactions.length - 1]?.payload ?? {};
  console.log("  audit payload:", JSON.stringify(e));
  check("policy recorded as 'redacted'", e.policy === "redacted", `policy=${e.policy}`);
  check("labels_stripped includes the sensitive 'tool_results:prior'",
    Array.isArray(e.labels_stripped) && e.labels_stripped.includes("tool_results:prior"),
    JSON.stringify(e.labels_stripped));
  check("prior_tool_results_stripped count ≥ 1", (e.prior_tool_results_stripped ?? 0) >= 1,
    `count=${e.prior_tool_results_stripped}`);
  check("bytes_withheld > 0", (e.bytes_withheld ?? 0) > 0, `bytes=${e.bytes_withheld}`);
  check("labels_kept includes 'persona:identity'",
    Array.isArray(e.labels_kept) && e.labels_kept.includes("persona:identity"),
    JSON.stringify(e.labels_kept));
  const keptSensitive = (e.labels_kept ?? []).filter((l) =>
    /^(memory:recall|memory:facts|vault:retrieval|tool_results:)/.test(l));
  check("labels_kept contains NO sensitive label (nothing private survived to Nous)",
    keptSensitive.length === 0, `leaked=${JSON.stringify(keptSensitive)}`);

  console.log("\n=== B) FULL policy (explicit opt-in) — no redaction must occur ===");
  const full = await reqJson("POST", "/api/settings", {
    cloudDataPolicy: { bartimaeus: "full" },
  });
  check("Bart cloud policy → full", full.status === 200, `status=${full.status}`);
  const beforeFull = readAudit("chat.egress_redaction").length;
  const turn2 = await reqJson("POST", "/api/chat", {
    personaId: "bartimaeus", model: BART_MODEL, messages: HISTORY,
  });
  check("chat turn accepted (full policy)", turn2.status === 200, `status=${turn2.status}`);
  await new Promise((r) => setTimeout(r, 500));
  const afterFull = readAudit("chat.egress_redaction").length;
  check("NO new redaction entry under 'full' (full data would have been sent)",
    afterFull === beforeFull, `before=${beforeFull} after=${afterFull}`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-egress-redaction: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
