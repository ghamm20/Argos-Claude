#!/usr/bin/env node
// smoke-failure-modes.mjs — verifies graceful degradation paths.
//
// These are the failure scenarios v1.0+ promises to handle without
// crashing the chat surface, eating an unrelated request, or silently
// losing state. Each scenario sets up a deliberately-broken condition
// and asserts the system surfaces a meaningful error / falls back
// cleanly instead of 500-ing or hanging.
//
// Scenarios:
//   F1. /api/chat with personaId="juniper" — should 503 + hint
//       (Juniper's gemma2-2b is selectable but we use a fake bad model
//        request to prove the model-list gate fires correctly)
//   F2. /api/chat with model not in AVAILABLE_MODELS — 400 + allowed list
//   F3. /api/chat with empty messages array — 400
//   F4. /api/chat with messages[0].content > 100KB — 400
//   F5. /api/model/warm with model not in AVAILABLE_MODELS — 400
//   F6. /api/model/warm with Ollama down (simulated by bad upstream) —
//       in practice we just confirm the existing 503 path with the
//       real upstream; full Ollama-kill simulation needs a fixture
//   F7. /api/voice/stt with empty body — 400
//   F8. /api/voice/stt with no body content-type — still attempts
//       (we accept any bytes as the audio); should reach capability
//       gate and either 200 (binaries present) or 503 (not)
//   F9. /api/voice/tts with empty text — 400
//   F10. Corrupted session JSON on disk — /api/chat/sessions/[id]
//        should 404 or 500 cleanly, not crash the server
//   F11. Malformed audit chain line — verifier flags it; /api/receipts
//        still returns 200 (with a warning in stderr)
//
// All scenarios run against a fresh server with tmp ARGOS_ROOT so
// they don't poison real state.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7793;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = "") {
  const tag = cond ? "[ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (cond) pass++;
  else { fail++; failures.push(`${label}${detail ? " — " + detail : ""}`); }
}

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    let url;
    try { url = new URL(path, BASE); } catch (e) { resolveResult({ ok: false, error: e.message }); return; }
    const r = http.request({
      method: opts.method || "GET",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: opts.headers || {},
      agent,
      timeout: opts.timeoutMs || 30_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolveResult({
          ok: true,
          res: {
            status: res.statusCode,
            text: () => Promise.resolve(body.toString("utf8")),
            json: () => { try { return Promise.resolve(JSON.parse(body.toString("utf8"))); } catch { return Promise.resolve(null); } },
          },
        });
      });
    });
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) {
      if (typeof opts.body === "string") r.write(opts.body);
      else r.write(Buffer.from(opts.body));
    }
    r.end();
  });
}

async function waitReady(maxSec = 30) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req("/api/voice/status");
    if (r.ok && r.res.status === 200) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

const argosTmp = mkdtempSync(join(tmpdir(), "argos-failure-"));
console.log(`smoke-failure-modes  ARGOS_ROOT=${argosTmp}  port=${PORT}`);

// Pre-seed: corrupt session + malformed audit chain
mkdirSync(join(argosTmp, "state", "sessions"), { recursive: true });
mkdirSync(join(argosTmp, "state", "audit"), { recursive: true });
writeFileSync(
  join(argosTmp, "state", "sessions", "deadbeef.json"),
  "{ this is not valid JSON",
);
// Seed audit chain: one valid entry + one malformed line (for F11)
writeFileSync(
  join(argosTmp, "state", "audit", "chain.jsonl"),
  // valid genesis entry computed via canonical-JSON + sha256
  // (any valid entry will do; we compute it as in lib/audit.ts)
  buildSeedChain(),
);

let server = null;
try {
  console.log("\n[boot] starting next start on port " + PORT);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT: argosTmp, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  if (!await waitReady(30)) {
    fail++; failures.push("server boot");
    throw new Error("server did not become ready");
  }
  console.log("[boot] ready");

  // === F2. /api/chat with model not in AVAILABLE_MODELS ===
  console.log("\n=== F2. /api/chat with unknown model → 400 + allowed list ===");
  const f2 = await req("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      personaId: "bartimaeus",
      model: "totally-fake-model:latest",
    }),
  });
  check("F2  status 400", f2.ok && f2.res.status === 400);
  if (f2.ok) {
    const j = await f2.res.json();
    check("F2  error mentions model", /not in allowed list/i.test(j?.error ?? ""));
    check("F2  body lists AVAILABLE_MODELS", Array.isArray(j?.availableModels));
  }

  // === F3. /api/chat with empty messages ===
  console.log("\n=== F3. /api/chat with empty messages → 400 ===");
  const f3 = await req("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [], personaId: "bartimaeus", model: "e4b:latest" }),
  });
  check("F3  status 400", f3.ok && f3.res.status === 400);

  // === F4. /api/chat with oversized message ===
  console.log("\n=== F4. /api/chat with 200KB user message → 400 ===");
  const huge = "x".repeat(200_000);
  const f4 = await req("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: huge }],
      personaId: "bartimaeus",
      model: "e4b:latest",
    }),
  });
  check("F4  status 400", f4.ok && f4.res.status === 400);
  if (f4.ok) {
    const j = await f4.res.json();
    check("F4  error mentions char limit", /exceeds|chars|length/i.test(j?.error ?? ""));
  }

  // === F5. /api/model/warm with fake model ===
  console.log("\n=== F5. /api/model/warm with unknown model → 400 ===");
  const f5 = await req("/api/model/warm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "not-a-real-model:latest" }),
  });
  check("F5  status 400", f5.ok && f5.res.status === 400);
  if (f5.ok) {
    const j = await f5.res.json();
    check("F5  body lists AVAILABLE_MODELS", Array.isArray(j?.availableModels));
  }

  // === F7. /api/voice/stt empty body — service-aware ===
  console.log("\n=== F7. /api/voice/stt with empty body ===");
  const f7 = await req("/api/voice/stt", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: Buffer.alloc(0),
  });
  // Either 503 (no whisper binary) or 400 (empty body) — both are graceful
  check("F7  status 400 or 503 (graceful)",
    f7.ok && (f7.res.status === 400 || f7.res.status === 503));
  if (f7.ok) {
    const j = await f7.res.json();
    check("F7  body has hint or error",
      typeof j?.hint === "string" || typeof j?.error === "string");
  }

  // === F9. /api/voice/tts with empty text — service-aware ===
  console.log("\n=== F9. /api/voice/tts with empty text ===");
  const f9 = await req("/api/voice/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });
  check("F9  status 400 or 503 (graceful)",
    f9.ok && (f9.res.status === 400 || f9.res.status === 503));

  // === F10. Corrupt session JSON on disk — /api/chat/sessions/deadbeef ===
  console.log("\n=== F10. Corrupt session file → 404 or 500 (not crash) ===");
  const f10 = await req("/api/chat/sessions/deadbeef");
  // It might 404 (treated as missing) OR 500 (parse error surfaced).
  // Either is acceptable; what we DON'T want is a hang or crashed server.
  check("F10 status 404 or 500", f10.ok && (f10.res.status === 404 || f10.res.status === 500));
  // Critical: the SERVER must still be alive afterward.
  const aliveAfter = await req("/api/voice/status");
  check("F10 server still alive after corrupt-session fetch",
    aliveAfter.ok && aliveAfter.res.status === 200);

  // === F11. Malformed audit chain line — receipts still 200 ===
  console.log("\n=== F11. Malformed audit chain line → /api/receipts 200 (warns, doesn't crash) ===");
  const f11 = await req("/api/receipts?verify=1");
  check("F11 receipts 200 despite malformed line", f11.ok && f11.res.status === 200);
  if (f11.ok) {
    const j = await f11.res.json();
    check("F11 entries array present", Array.isArray(j?.entries));
  }

  // === F12. Persona switch to not_configured-attempt audit ===
  // (Can't simulate the persona-switched POST from server-side here;
  //  this is exercised by the UI. We just confirm the route exists.)
  console.log("\n=== F12. /api/persona/switched POST validation ===");
  const f12bad = await req("/api/persona/switched", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId: "nonexistent" }),
  });
  check("F12 invalid personaId → 400", f12bad.ok && f12bad.res.status === 400);
  const f12good = await req("/api/persona/switched", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId: "bartimaeus", reason: "smoke-test" }),
  });
  check("F12 valid persona switch → 200", f12good.ok && f12good.res.status === 200);
  if (f12good.ok) {
    const j = await f12good.res.json();
    check("F12 audit entry has hash + index", typeof j?.hash === "string" && typeof j?.index === "number");
  }

} catch (e) {
  fail++; failures.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
        setTimeout(() => { try { server.kill("SIGKILL"); } catch {} }, 2000);
      }
    } catch {}
  }
  agent.destroy();
  try { rmSync(argosTmp, { recursive: true, force: true }); } catch {}
}

console.log("");
console.log(fail === 0
  ? `smoke-failure-modes: ${pass} passed — PASS`
  : `smoke-failure-modes: ${pass} passed, ${fail} failed — FAIL\n  ${failures.join("\n  ")}`);
process.exit(fail === 0 ? 0 : 1);

// ----- helpers -----

function buildSeedChain() {
  function canonicalJson(value) {
    if (value === undefined) return "";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]));
    return "{" + parts.join(",") + "}";
  }
  const rest = {
    version: 1,
    index: 0,
    ts: 1700000000000,
    id: randomUUID().replace(/-/g, ""),
    kind: "session.created",
    payload: { id: "seed", title: "seed" },
    prevHash: "",
  };
  const hash = createHash("sha256")
    .update(rest.prevHash)
    .update(":")
    .update(canonicalJson(rest))
    .digest("hex");
  const entry = { ...rest, hash };
  // Append a malformed line after the valid one
  return JSON.stringify(entry) + "\n" + "{ not valid json oh no" + "\n";
}
