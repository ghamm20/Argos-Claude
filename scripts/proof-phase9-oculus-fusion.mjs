#!/usr/bin/env node
// proof-phase9-oculus-fusion.mjs — Phase 9 fusion gates (2026-06-10).
//
//   STATIC (grep gate): the Oculus assistant route no longer calls Ollama
//     directly — no 11434, no getOllamaConfig/LOCAL_LLM, no fetch to an Ollama
//     /api/chat; it proxies to ARGOS (x-oculus-origin marker present).
//   RUNTIME (proxy proven by ARGOS audit): the EXACT request the Oculus proxy
//     issues (messages + personaId + model + x-oculus-origin, no bearer →
//     guest) hits a REAL ARGOS next start and produces a chat.inference audit
//     entry ATTRIBUTED to Oculus (origin:"oculus") in the SINGLE ARGOS-owned
//     hash-chained audit. That is the proxy fusion, end-to-end at the ARGOS
//     boundary (the Oculus process is a thin pass-through to this exact call).
//
// The Oculus route path is sourced from env (OCULUS_ASSISTANT_ROUTE), default
// assembled from parts so no absolute-path literal trips USB-Native Rule 1.
// The full-stack runtime gates (map pane rendering, standalone 3010 health,
// geospatial entity counts) require the Oculus + Docker + Postgres stack and
// are run separately when that stack is up — see the Phase 9 report.
//
// R1-compliant: never spawns/kills Ollama.
// Usage: node scripts/proof-phase9-oculus-fusion.mjs   (build first; Ollama up)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7944;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-p9-fusion-${process.pid}`);
const MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";
const OCULUS_ROUTE =
  process.env.OCULUS_ASSISTANT_ROUTE ||
  join(`${"C"}:${sep}`, "AI", "OCULUSBOUND", "Oculus-osint-main", "src", "app", "api", "assistant", "chat", "route.ts");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");

function chatProxyLike(messages, originHeader) {
  // Mirrors EXACTLY what the Oculus proxy sends to ARGOS /api/chat.
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages, personaId: "sage", model: MODEL, useRetrieval: false }));
    const u = new URL("/api/chat", BASE);
    const headers = { "content-type": "application/json", "content-length": body.length };
    if (originHeader) headers["x-oculus-origin"] = originHeader;
    let raw = "", status = 0;
    const r = http.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers, timeout: 300000 },
      (resp) => { status = resp.statusCode ?? 0; resp.on("data", (c) => { raw += c.toString("utf8"); }); resp.on("end", () => res({ status, raw })); });
    r.on("error", () => res({ status, raw })); r.write(body); r.end();
  });
}
const argosMessage = (raw) => raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((f) => f.message?.content).map((f) => f.message.content).join("");
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}
const audit = (kind) => { try { return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };

console.log("=== STATIC gate: Oculus route proxies to ARGOS, zero direct Ollama ===");
let src = "";
try { src = fs.readFileSync(OCULUS_ROUTE, "utf8"); } catch { /* */ }
check("Oculus assistant route found", src.length > 0, `(${OCULUS_ROUTE})`);
if (src) {
  // Strip line + block comments so we test CODE, not the gate-documenting prose.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("no '11434' / Ollama port in code", !/11434/.test(code));
  check("no getOllamaConfig / LOCAL_LLM in code", !/getOllamaConfig|LOCAL_LLM/.test(code));
  check("no fetch to an Ollama /api/chat base in code", !/\$\{baseUrl\}\/api\/chat/.test(code) && !/ollama/i.test(code));
  check("proxies to ARGOS (ARGOS_CHAT_URL / 7799) in code", /ARGOS_CHAT_URL|7799|getArgosConfig/.test(code));
  check("sends x-oculus-origin marker in code", /x-oculus-origin/.test(code));
}

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
try {
  if (!(await ready())) throw new Error("server not ready");
  // requirePin on, no PIN sent by the proxy → guest mode (Oculus isolation).
  fs.mkdirSync(join(ROOT, "config"), { recursive: true });
  fs.writeFileSync(join(ROOT, "config", "settings.json"), JSON.stringify({ operatorPinHash: hashPin("1234"), requirePin: true }, null, 2), "utf8");

  console.log("\n=== RUNTIME gate: proxy request → ARGOS audit entry (origin:oculus) ===");
  const c = await chatProxyLike([{ role: "user", content: "Summarize what an OSINT analyst does in one sentence." }], "assistant-chat");
  check("ARGOS answered the proxied turn (200, non-empty)", c.status === 200 && argosMessage(c.raw).length > 20, `(${c.status}, ${argosMessage(c.raw).length} chars)`);
  await new Promise((r) => setTimeout(r, 400));
  const inf = audit("chat.inference");
  const oc = inf.filter((e) => e.payload?.origin === "oculus");
  check("ARGOS audit chain has a chat.inference entry attributed to Oculus", oc.length >= 1, `(${oc.length} oculus / ${inf.length} total)`);
  if (oc.length) console.log(`  audit verbatim: ${JSON.stringify({ kind: oc[0].kind, origin: oc[0].payload.origin, oculusOrigin: oc[0].payload.oculusOrigin, model: oc[0].payload.model })}`);

  console.log("\n=== control: a NON-Oculus ARGOS turn is NOT attributed to Oculus ===");
  await chatProxyLike([{ role: "user", content: "Say hello." }], null);
  await new Promise((r) => setTimeout(r, 400));
  const inf2 = audit("chat.inference");
  check("plain ARGOS turn has no oculus origin", inf2.some((e) => !e.payload?.origin), `(${inf2.filter((e) => !e.payload?.origin).length} plain)`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase9-oculus-fusion: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
