#!/usr/bin/env node
// proof-phase9-runtime-gates-live.mjs — Phase 9 four runtime gates, LIVE-DEPLOY mode.
//
// The owner ruled Gate A must read the CURRENT live deploy's audit chain, not a
// throwaway spawned ARGOS (HANDOFF-PHASE9.md §5). This variant therefore spawns
// NOTHING: the real deploy must already be running (launcher.bat) and the Oculus
// stack must be up. The four gate conditions are IDENTICAL to
// proof-phase9-runtime-gates.mjs (frozen at phase start — Rule 11); only the
// observation point moved from a spawned instance to the live one.
//
//   Gate A — POST the real Oculus /api/assistant/chat → the LIVE ARGOS audit
//            chain gains a chat.inference entry attributed origin:"oculus".
//   Gate B — Oculus serves /api/health + /api/sensors/entities independently.
//   Gate C — ARGOS /workspace serves; the Oculus map document is reachable.
//   Gate D — entity count intact pre/post a proxied turn; if no_data_loaded,
//            one /api/sensors/refresh establishes a baseline and the data
//            source is STATED (owner requirement).
//
// Usage:
//   set LIVE_ARGOS_ROOT=<deploy root>   (REQUIRED — chain.jsonl lives under it;
//                                        not hardcoded per USB-Native Rule 1)
//   node scripts/proof-phase9-runtime-gates-live.mjs
//   env: ARGOS_URL (default http://127.0.0.1:7799), OCULUS_URL (default http://127.0.0.1:3011)

import { join } from "node:path";
import fs from "node:fs";
import http from "node:http";

const ROOT = process.env.LIVE_ARGOS_ROOT;
if (!ROOT || !fs.existsSync(join(ROOT, "state", "audit", "chain.jsonl"))) {
  console.error("[fatal] LIVE_ARGOS_ROOT must point at the running deploy (state/audit/chain.jsonl not found)");
  process.exit(1);
}
const ARGOS = (process.env.ARGOS_URL || "http://127.0.0.1:7799").replace(/\/+$/, "");
const OCULUS = (process.env.OCULUS_URL || "http://127.0.0.1:3011").replace(/\/+$/, "");
const CHAIN = join(ROOT, "state", "audit", "chain.jsonl");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(base, path, { method = "GET", body = null, headers = {}, timeout = 180000 } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, base);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers }, timeout },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch { /* */ } res({ status: resp.statusCode, text, json }); }); });
    r.on("error", () => res({ status: 0, text: "", json: null }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, text: "", json: null }); });
    if (payload) r.write(payload); r.end();
  });
}
const chainEntries = () => fs.readFileSync(CHAIN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

console.log(`LIVE mode: ARGOS=${ARGOS}  OCULUS=${OCULUS}  chain=${CHAIN}`);

console.log("\n=== Gate B: Oculus standalone serves independently ===");
const health = await req(OCULUS, "/api/health");
check("Oculus /api/health 200", health.status === 200, JSON.stringify(health.json));
const ents0 = await req(OCULUS, "/api/sensors/entities");
check("Oculus /api/sensors/entities reachable (standalone data plane)", ents0.status === 200);

console.log("\n=== Gate D (pre): baseline entity count ===");
let preTotal = ents0.json?.total ?? 0;
let dataSource = ents0.json?.no_data_loaded ? "empty" : "pre-existing";
if (ents0.json?.no_data_loaded || preTotal === 0) {
  console.log("  DB empty → triggering one live-feed pull for a baseline…");
  const rf = await req(OCULUS, "/api/sensors/refresh", { method: "POST" });
  console.log(`  refresh status: ${rf.status}`);
  await sleep(10000);
  const after = await req(OCULUS, "/api/sensors/entities");
  preTotal = after.json?.total ?? 0;
  dataSource = "live-feed (post-refresh)";
}
check("baseline entity count established", preTotal > 0, `(total=${preTotal}, source=${dataSource})`);

console.log("\n=== Gate A: live pane query → LIVE ARGOS audit entry ===");
const baselineLen = chainEntries().length;
const baselineOculus = chainEntries().filter((e) => e.kind === "chat.inference" && e.payload?.origin === "oculus").length;
console.log(`  live chain baseline: ${baselineLen} entries, ${baselineOculus} prior origin:oculus`);
const t0 = Date.now();
const ask = await req(OCULUS, "/api/assistant/chat", { method: "POST", body: { messages: [{ role: "user", content: "In one sentence, what is OSINT?" }] } });
const turnMs = Date.now() - t0;
check("Oculus assistant answered via the proxy (200, message)", ask.status === 200 && typeof ask.json?.message === "string" && ask.json.message.length > 10, `(${ask.status}, ${ask.json?.message?.length ?? 0} chars, ${turnMs}ms)`);
await sleep(1500);
const oc = chainEntries().filter((e) => e.kind === "chat.inference" && e.payload?.origin === "oculus");
check("LIVE ARGOS audit chain gained the Oculus query (origin:oculus)", oc.length > baselineOculus, `(${baselineOculus} → ${oc.length} oculus entries)`);
if (oc.length > baselineOculus) {
  const last = oc[oc.length - 1];
  console.log(`  audit verbatim: ${JSON.stringify({ index: last.index, origin: last.payload.origin, oculusOrigin: last.payload.oculusOrigin, persona: last.payload.persona, backend: last.payload.backend, model: last.payload.model, latency_ms: last.payload.latency_ms })}`);
}

console.log("\n=== Gate D (post): entity count intact after fusion activity ===");
const ents1 = await req(OCULUS, "/api/sensors/entities");
const postTotal = ents1.json?.total ?? -1;
check("entity count intact pre/post (fusion did not drop entities)", postTotal >= preTotal, `(pre=${preTotal}, post=${postTotal}, source=${dataSource})`);

console.log("\n=== Gate C: map pane renders in the ARGOS workspace ===");
const ws = await req(ARGOS, "/workspace");
const mapDoc = await req(OCULUS, "/");
check("ARGOS /workspace serves (map pane host)", ws.status === 200);
check("Oculus map document reachable for the pane iframe", mapDoc.status === 200 || mapDoc.status === 307 || mapDoc.status === 308, `(status=${mapDoc.status})`);

console.log(`\n  DATA SOURCE for the count gate: ${dataSource} (baseline ${preTotal} entities)`);
console.log(`\nproof-phase9-runtime-gates-live: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
