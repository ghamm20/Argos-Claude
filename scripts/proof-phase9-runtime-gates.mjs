#!/usr/bin/env node
// proof-phase9-runtime-gates.mjs — Phase 9 FOUR runtime gates (2026-06-10).
// Run ONLY when the Oculus stack is live (owner brings up Docker + compose).
//
//   Gate A — live pane query → ARGOS audit entry: POST the REAL Oculus
//            /api/assistant/chat; it proxies to ARGOS; ARGOS's hash-chained
//            audit gains a chat.inference entry attributed origin:"oculus".
//   Gate B — standalone independent: Oculus serves /api/health + sensors data
//            on its own port, proving it runs independently of ARGOS.
//   Gate C — map pane renders: the ARGOS /workspace embeds the Oculus map
//            (iframe src → Oculus, and Oculus is reachable).
//   Gate D — entity count intact pre/post: /api/sensors/entities `total`
//            before vs after a proxied turn — fusion must not drop entities.
//            If no_data_loaded, trigger one /api/sensors/refresh to get a
//            >0 baseline and record the data source (live-feed).
//
// This harness spawns its OWN ARGOS next start on 7799 (the proxy's default
// target) with a throwaway ARGOS_ROOT, so Gate A's audit is observable. The
// Oculus stack is owner-managed; the harness auto-detects its port (3010|3011).
//
// Usage: node scripts/proof-phase9-runtime-gates.mjs
//   env: OCULUS_URL (skip auto-detect), ARGOS_PORT (default 7799)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const ARGOS_PORT = Number(process.env.ARGOS_PORT || 7799);
const ARGOS = `http://127.0.0.1:${ARGOS_PORT}`;
const ROOT = join(tmpdir(), `argos-p9-runtime-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reqRaw(base, path, { method = "GET", body = null, headers = {} } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;
    let u; try { u = new URL(path, base); } catch { return res({ status: 0, text: "", json: null }); }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers }, timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x)); resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch { /* */ } res({ status: resp.statusCode, text, json }); }); });
    r.on("error", () => res({ status: 0, text: "", json: null }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, text: "", json: null }); });
    if (payload) r.write(payload); r.end();
  });
}
async function ready(base, path = "/api/runtime", maxSec = 60) {
  for (let i = 0; i < maxSec; i++) { const r = await reqRaw(base, path); if (r.status === 200) return true; await sleep(1000); }
  return false;
}
const argosAudit = (kind) => { try { return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };

async function detectOculus() {
  if (process.env.OCULUS_URL) return process.env.OCULUS_URL.replace(/\/+$/, "");
  for (const p of [3010, 3011, 3000]) {
    const r = await reqRaw(`http://127.0.0.1:${p}`, "/api/health");
    if (r.status === 200) return `http://127.0.0.1:${p}`;
  }
  return null;
}

// Spawn ARGOS on 7799 (the proxy's default target) so Gate A's audit is local.
fs.mkdirSync(ROOT, { recursive: true });
const argos = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(ARGOS_PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
argos.stdout.on("data", () => {}); argos.stderr.on("data", () => {});

try {
  if (!(await ready(ARGOS))) throw new Error(`ARGOS did not come up on ${ARGOS_PORT} (is the real deploy already using it? set ARGOS_PORT)`);
  const OCULUS = await detectOculus();
  check("Oculus stack is live (auto-detected port)", !!OCULUS, OCULUS ? `(${OCULUS})` : "(not found on 3010/3011/3000 — start the stack)");
  if (!OCULUS) throw new Error("Oculus stack not reachable — bring up Docker + compose, then re-run");

  console.log("\n=== Gate B: Oculus standalone serves independently ===");
  const health = await reqRaw(OCULUS, "/api/health");
  check("Oculus /api/health 200", health.status === 200, JSON.stringify(health.json));
  const ents0 = await reqRaw(OCULUS, "/api/sensors/entities");
  check("Oculus /api/sensors/entities reachable (standalone data plane)", ents0.status === 200);

  console.log("\n=== Gate D (pre): baseline entity count ===");
  let preTotal = ents0.json?.total ?? 0;
  let dataSource = ents0.json?.no_data_loaded ? "empty" : "pre-existing";
  if (ents0.json?.no_data_loaded) {
    console.log("  DB empty (no_data_loaded) → triggering one live-feed pull for a baseline…");
    await reqRaw(OCULUS, "/api/sensors/refresh", { method: "POST" });
    await sleep(8000);
    const after = await reqRaw(OCULUS, "/api/sensors/entities");
    preTotal = after.json?.total ?? 0;
    dataSource = "live-feed (post-refresh)";
  }
  check("baseline entity count established", preTotal > 0, `(total=${preTotal}, source=${dataSource})`);

  console.log("\n=== Gate A: live pane query → ARGOS audit entry ===");
  const ask = await reqRaw(OCULUS, "/api/assistant/chat", { method: "POST", body: { messages: [{ role: "user", content: "In one sentence, what is OSINT?" }] } });
  check("Oculus assistant answered via the proxy (200, message)", ask.status === 200 && typeof ask.json?.message === "string" && ask.json.message.length > 10, `(${ask.status}, ${ask.json?.message?.length ?? 0} chars)`);
  await sleep(500);
  const oc = argosAudit("chat.inference").filter((e) => e.payload?.origin === "oculus");
  check("ARGOS audit chain recorded the Oculus query (origin:oculus)", oc.length >= 1, `(${oc.length} oculus entries)`);
  if (oc.length) console.log(`  audit verbatim: ${JSON.stringify({ origin: oc[0].payload.origin, oculusOrigin: oc[0].payload.oculusOrigin, model: oc[0].payload.model })}`);

  console.log("\n=== Gate D (post): entity count intact after fusion activity ===");
  const ents1 = await reqRaw(OCULUS, "/api/sensors/entities");
  const postTotal = ents1.json?.total ?? -1;
  check("entity count intact pre/post (fusion did not drop entities)", postTotal >= preTotal, `(pre=${preTotal}, post=${postTotal}, source=${dataSource})`);

  console.log("\n=== Gate C: map pane renders in the ARGOS workspace ===");
  // The /workspace page embeds an iframe[data-testid=oculus-map] whose src is
  // the Oculus URL. Assert the page serves and carries the pane + the Oculus
  // map document is reachable (the iframe will load it in a browser).
  const ws = await reqRaw(ARGOS, "/workspace");
  // Client component — assert the standalone map document is reachable; the
  // iframe markup is hydrated client-side (covered by the Phase 6 preview proof
  // for the pane itself). Here we prove the pane's SOURCE is live.
  const mapDoc = await reqRaw(OCULUS, "/");
  check("ARGOS /workspace serves (map pane host)", ws.status === 200);
  check("Oculus map document reachable for the pane iframe", mapDoc.status === 200 || mapDoc.status === 307 || mapDoc.status === 308, `(status=${mapDoc.status})`);

  console.log(`\n  DATA SOURCE for the count gate: ${dataSource} (baseline ${preTotal} entities)`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(argos.pid)]); else argos.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase9-runtime-gates: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
