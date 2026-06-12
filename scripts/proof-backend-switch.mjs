#!/usr/bin/env node
// proof-backend-switch.mjs — Task 1 acceptance (2026-06-12 owner directive:
// THE SWITCH JUST WORKS).
//
// Spawns the freshly built server on a THROWAWAY ARGOS_ROOT (never the live
// deploy state), configures the real Nous key + a proof-local PIN, then
// demonstrates the full authed switch loop:
//
//   1. configure key + PIN (bootstrap path, pre-auth)
//   2. mint an operator session via /api/auth/verify
//   3. NEGATIVE: flip backend WITHOUT a session → 401, nothing written
//   4. flip backend → nous WITH the session → 200; settings.changed audit
//      entry carries old→new VALUES
//   5. chat turn → leading backend frame says backend:"nous" + the exact
//      nemotron model id; content non-empty; chat.inference audit entry has
//      backend:"nous", requested_backend:"nous", content tokens present
//   6. flip back → local (audited old→new); chat turn answers local with
//      requested_backend:"local"
//
// The Nous key is decrypted from the LIVE deploy config (read-only) and
// passed into the proof root via the settings API; it is never logged.
// Requires: built .next, Ollama up (local leg), Nous reachable (cloud leg).
//
// Usage: node scripts/proof-backend-switch.mjs [--port 7902]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { createHash, createDecipheriv } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7902;
// Deploy root: env override, else assembled from parts (USB-native Rule 1).
const DEPLOY_ROOT = process.env.ARGOS_DEPLOY_ROOT || ["D:", "ARGOS"].join("\\");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

// ---- decrypt the real Nous key from the live deploy (read-only) ----
function loadDeployNousKey() {
  const s = JSON.parse(fs.readFileSync(join(DEPLOY_ROOT, "config", "settings.json"), "utf8"));
  const v = s.nousApiKey;
  if (!v) throw new Error("deploy has no nousApiKey configured");
  if (!v.startsWith("enc:v1:")) return v;
  const keyHex = fs.readFileSync(join(DEPLOY_ROOT, "config", ".argos-secret-key"), "utf8").trim();
  const [iv, tag, data] = v.slice("enc:v1:".length).split(":");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
}

const PIN = "424242";
const pinHash = createHash("sha256").update(`ARGOS_OPERATOR_${PIN.length}${PIN}`).digest("hex");

const ROOT = join(tmpdir(), `argos-switch-proof-${process.pid}`);
fs.mkdirSync(ROOT, { recursive: true });
const base = `http://127.0.0.1:${PORT}`;

const jfetch = async (path, opts = {}) => {
  const r = await fetch(new URL(path, base), opts);
  let body = null;
  try { body = await r.json(); } catch { /* stream/empty */ }
  return { status: r.status, body, raw: r };
};
const post = (path, body, token) =>
  jfetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const audit = (kind) => {
  try {
    return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind);
  } catch { return []; }
};

// Send a chat turn; return { backendFrame, content } from the ndjson stream.
async function chatTurn(token, text) {
  const r = await fetch(new URL("/api/chat", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      personaId: "bartimaeus",
      model: "aratan/gemma-4-E4B-q8-it-heretic:latest",
      useRetrieval: false,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!r.ok || !r.body) return { status: r.status, backendFrame: null, content: "" };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", backendFrame = null, content = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === "backend") backendFrame = j;
        if (j.message?.content) content += j.message.content;
      } catch { /* non-json frame */ }
    }
  }
  return { status: r.status, backendFrame, content };
}

console.log(`proof-backend-switch — throwaway root: ${ROOT}`);
const nousKey = loadDeployNousKey();
console.log("nous key: decrypted from deploy (not shown)");

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  // readiness
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    ready = await fetch(new URL("/api/runtime", base)).then((r) => r.ok).catch(() => false);
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("server not ready");

  console.log("=== 1. bootstrap: key + PIN (pre-auth path) ===");
  const k = await post("/api/settings", { nousApiKey: nousKey });
  check("nous key accepted", k.status === 200);
  const p = await post("/api/settings", { operatorPinHash: pinHash, requirePin: true });
  check("PIN configured + requirePin on", p.status === 200);

  console.log("=== 2. mint operator session ===");
  const v = await post("/api/auth/verify", { pinHash });
  const token = v.body?.token;
  check("session token minted", v.status === 200 && typeof token === "string");

  console.log("=== 3. NEGATIVE: flip without a session ===");
  const n1 = await post("/api/settings", { inferenceBackend: "nous" });
  check("unauthenticated flip → 401", n1.status === 401, `status=${n1.status}`);
  const sNeg = JSON.parse(fs.readFileSync(join(ROOT, "config", "settings.json"), "utf8"));
  check("disk state unchanged (still local)", sNeg.inferenceBackend !== "nous");

  console.log("=== 4. authed flip → API (nous) ===");
  const f1 = await post("/api/settings", { inferenceBackend: "nous" }, token);
  check("authed flip accepted", f1.status === 200);
  const sc1 = audit("settings.changed").filter((e) => e.payload?.changes?.inferenceBackend);
  const last1 = sc1[sc1.length - 1]?.payload?.changes?.inferenceBackend;
  check(
    "settings.changed audits old→new VALUES",
    last1 && last1.from === "local" && last1.to === "nous",
    JSON.stringify(last1)
  );

  console.log("=== 5. chat turn answers FROM NEMOTRON ===");
  const t1 = await chatTurn(token, "Identify yourself in one short sentence.");
  check("turn streamed (200)", t1.status === 200);
  check(
    "backend frame: backend=nous, nemotron model",
    t1.backendFrame?.backend === "nous" && /nemotron/i.test(t1.backendFrame?.model ?? ""),
    JSON.stringify(t1.backendFrame)
  );
  check("requestedBackend=nous in frame", t1.backendFrame?.requestedBackend === "nous");
  check(`content non-empty (${t1.content.length}ch)`, t1.content.trim().length > 0);
  const inf1 = audit("chat.inference").pop();
  check(
    "chat.inference: backend=nous, requested_backend=nous, tokens present",
    inf1?.payload?.backend === "nous" && inf1?.payload?.requested_backend === "nous" && (inf1?.payload?.completion_tokens ?? 0) > 0,
    JSON.stringify({ backend: inf1?.payload?.backend, requested: inf1?.payload?.requested_backend, completion: inf1?.payload?.completion_tokens, fallback: inf1?.payload?.fallback_reason })
  );

  console.log("=== 6. flip back → Local; next turn local ===");
  const f2 = await post("/api/settings", { inferenceBackend: "local" }, token);
  check("flip back accepted", f2.status === 200);
  const sc2 = audit("settings.changed").filter((e) => e.payload?.changes?.inferenceBackend);
  const last2 = sc2[sc2.length - 1]?.payload?.changes?.inferenceBackend;
  check("flip-back audited old→new", last2 && last2.from === "nous" && last2.to === "local", JSON.stringify(last2));
  const t2 = await chatTurn(token, "One short sentence: what backend are you on?");
  check(
    "next turn answers LOCAL (backend frame)",
    t2.status === 200 && t2.backendFrame?.backend === "local" && t2.backendFrame?.requestedBackend === "local",
    JSON.stringify(t2.backendFrame)
  );
  check(`local content non-empty (${t2.content.length}ch)`, t2.content.trim().length > 0);
  const inf2 = audit("chat.inference").pop();
  check(
    "chat.inference: backend=local, requested_backend=local",
    inf2?.payload?.backend === "local" && inf2?.payload?.requested_backend === "local"
  );
} finally {
  try { spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-backend-switch: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
