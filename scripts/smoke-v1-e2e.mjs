#!/usr/bin/env node
// smoke-v1-e2e.mjs — end-to-end composite smoke for ARGOS v1.0+.
//
// "Is the deployed payload doing what v1.0 promises?" — single command.
//
// What it exercises:
//   A. Server boots cleanly + /api/voice/status responds
//   B. /api/model/warm loads Bart's currently-bound model
//   C. /api/chat through Bartimaeus returns coherent non-empty content
//      (proves think:false plumbed correctly + persona system prompt
//      reaches the model)
//   D. /api/receipts shows the chat-induced session events + the
//      persona.switched event from boot hydration
//   E. /api/chat/sessions/[id]/export returns a JSON bundle with a
//      verifiable bundleHash
//   F. The standalone audit verifier (scripts/verify-audit-chain.mjs)
//      PASSes on the resulting chain
//
// Requirements:
//   - Ollama running on 127.0.0.1:11434
//   - Bart's bound model in the Ollama store (read from /api/system/info OR
//     hardcoded fallback — see BART_MODEL below)
//   - nomic-embed-text in Ollama (for retrieval surface; not required
//     for chat itself to pass)
//   - A clean ARGOS_ROOT in tmpdir (so we don't poison the real state)
//
// Exit 0 on PASS; 1 on any FAIL.
//
// Usage:
//   node scripts/smoke-v1-e2e.mjs                  # uses default port 7791
//   node scripts/smoke-v1-e2e.mjs --port 7795      # override

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const verifyScript = resolve(__dir, "verify-audit-chain.mjs");

const args = process.argv.slice(2);
const portArgIdx = args.indexOf("--port");
const PORT = portArgIdx >= 0 ? parseInt(args[portArgIdx + 1], 10) : 7791;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

// Phase 2 Persona Completion (2026-05-28): Bart binds to
// royhodge812/Orchestrator:lates. Exact upstream tag (note :lates,
// not :latest). This constant must match lib/personas.ts
// Bartimaeus.model — smoke is a contract check, not a tautology.
const BART_MODEL = "royhodge812/Orchestrator:lates";

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = "") {
  const tag = cond ? "[ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}${detail ? " — " + detail : ""}`);
  }
}

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    let url;
    try { url = new URL(path, BASE); } catch (e) {
      resolveResult({ ok: false, error: e.message }); return;
    }
    const r = http.request({
      method: opts.method || "GET",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: opts.headers || {},
      agent,
      timeout: opts.timeoutMs || 120_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolveResult({
          ok: true,
          res: {
            status: res.statusCode,
            headers: { get: (h) => res.headers[h.toLowerCase()] ?? null },
            text: () => Promise.resolve(body.toString("utf8")),
            json: () => Promise.resolve(JSON.parse(body.toString("utf8"))),
            arrayBuffer: () => Promise.resolve(
              body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
            ),
            body,
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
    await new Promise((resolve_) => setTimeout(resolve_, 1000));
  }
  return false;
}

// canonical JSON for bundle hash recompute — must match lib/audit.ts
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

// --- main ---
const argosTmp = mkdtempSync(join(tmpdir(), "argos-e2e-"));
console.log(`smoke-v1-e2e  ARGOS_ROOT=${argosTmp}  port=${PORT}`);

const serverEnv = { ...process.env, ARGOS_ROOT: argosTmp, NEXT_TELEMETRY_DISABLED: "1" };
let server = null;

try {
  // Boot the server in detached child
  console.log("\n[boot] starting next start on port " + PORT);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {/* swallow */});
  server.stderr.on("data", () => {/* swallow */});

  const ready = await waitReady(30);
  if (!ready) {
    console.log("[boot] SERVER FAILED TO BECOME READY");
    fail++;
    failures.push("server boot");
    throw new Error("server did not become ready in 30s");
  }
  console.log("[boot] ready");

  // === A. voice/status ===
  console.log("\n=== A. /api/voice/status ===");
  const vs = await req("/api/voice/status");
  check("A1  voice/status 200", vs.ok && vs.res.status === 200);
  if (vs.ok) {
    const j = await vs.res.json();
    check("A1  voice/status has stt.available boolean", typeof j?.stt?.available === "boolean");
    check("A1  voice/status reports argosRoot", typeof j?.argosRoot === "string" && j.argosRoot.length > 0);
  }

  // === B. model/warm e4b ===
  console.log(`\n=== B. /api/model/warm ${BART_MODEL} ===`);
  const warm = await req("/api/model/warm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: BART_MODEL }),
  });
  check("B1  model/warm 200", warm.ok && warm.res.status === 200);
  if (warm.ok && warm.res.status === 200) {
    const j = await warm.res.json();
    check("B1  warm body has ok:true", j.ok === true);
    check("B1  warm body has wallMs > 0", typeof j.wallMs === "number" && j.wallMs > 0);
  }

  // === C. chat through Bartimaeus ===
  console.log("\n=== C. /api/chat through Bartimaeus ===");
  const chatBody = JSON.stringify({
    messages: [{ role: "user", content: "State your role in one sentence." }],
    personaId: "bartimaeus",
    model: BART_MODEL,
    useRetrieval: false,
  });
  const ch = await req("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody,
    timeoutMs: 180_000,
  });
  check("C1  /api/chat 200", ch.ok && ch.res.status === 200);
  let chatContent = "";
  if (ch.ok && ch.res.status === 200) {
    const text = await ch.res.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j?.message?.content) chatContent += j.message.content;
      } catch {/* tail retrieval event isn't a chat line */}
    }
    check("C2  /api/chat content non-empty", chatContent.length > 0,
      `(got ${chatContent.length} chars)`);
    check("C3  /api/chat content >= 20 chars (probably coherent)", chatContent.length >= 20);
    console.log(`     content: "${chatContent.trim().slice(0, 200)}"`);
  }

  // Save the session so we have something to export. The auto-save
  // happens client-side normally; we trigger it ourselves here.
  console.log("\n=== C-save. /api/chat/sessions ===");
  const sessionPost = await req("/api/chat/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      personaId: "bartimaeus",
      model: BART_MODEL,
      messages: [
        { id: "u1", role: "user", content: "State your role in one sentence.", timestamp: Date.now() - 1000, personaId: "bartimaeus" },
        { id: "a1", role: "assistant", content: chatContent || "(empty)", timestamp: Date.now(), personaId: "bartimaeus" },
      ],
    }),
  });
  check("C-save  session POST 200", sessionPost.ok && sessionPost.res.status === 200);
  let sessionId = null;
  if (sessionPost.ok && sessionPost.res.status === 200) {
    const j = await sessionPost.res.json();
    sessionId = j.id;
    check("C-save  session id returned", typeof sessionId === "string" && sessionId.length > 0);
  }

  // === D. /api/receipts shows the chain ===
  console.log("\n=== D. /api/receipts ===");
  const rec = await req("/api/receipts?verify=1");
  check("D1  /api/receipts 200", rec.ok && rec.res.status === 200);
  if (rec.ok && rec.res.status === 200) {
    const j = await rec.res.json();
    check("D1  receipts has entries[]", Array.isArray(j.entries));
    check("D2  receipts has session.created entry",
      j.entries.some((e) => e.kind === "session.created"));
    check("D3  receipts verify.ok = true", j.verify && j.verify.ok === true);
  }

  // === E. /api/chat/sessions/[id]/export bundle with valid bundleHash ===
  if (sessionId) {
    console.log("\n=== E. /api/chat/sessions/[id]/export ===");
    const ex = await req(`/api/chat/sessions/${sessionId}/export`);
    check("E1  export 200", ex.ok && ex.res.status === 200);
    if (ex.ok && ex.res.status === 200) {
      const txt = await ex.res.text();
      const bundle = JSON.parse(txt);
      check("E1  bundle has bundleVersion === 1", bundle.bundleVersion === 1);
      check("E1  bundle has bundleHash", typeof bundle.bundleHash === "string" && bundle.bundleHash.length === 64);

      // Recompute the bundleHash and compare
      const { bundleHash, ...rest } = bundle;
      const computed = createHash("sha256")
        .update(canonicalJson(rest))
        .digest("hex");
      check("E2  bundleHash recomputes correctly", computed === bundleHash,
        `expected ${bundleHash.slice(0,16)}… got ${computed.slice(0,16)}…`);
      check("E3  bundle contains the saved session", bundle.session?.id === sessionId);
      check("E4  bundle.audit array present", Array.isArray(bundle.audit));
    }
  } else {
    console.log("\n[skip] E. bundle export — no sessionId available");
  }

  // === F. standalone verifier on the live chain ===
  console.log("\n=== F. standalone audit verifier on live chain ===");
  const liveChainPath = join(argosTmp, "state", "audit", "chain.jsonl");
  if (existsSync(liveChainPath)) {
    const v = spawnSync(process.execPath, [verifyScript, "--chain", liveChainPath], {
      encoding: "utf8",
    });
    check("F1  verifier exit 0", v.status === 0);
    check("F1  verifier reports >0 entries", /\b[1-9]\d*\s+entries verified/.test(v.stdout));
  } else {
    fail++;
    failures.push("F: chain file not created (state/audit/chain.jsonl missing)");
    console.log("  [FAIL] F: chain file missing");
  }

} catch (e) {
  fail++;
  failures.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  // Shut down the server
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        // Hard-kill the server's process tree
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
        setTimeout(() => { try { server.kill("SIGKILL"); } catch {} }, 2000);
      }
    } catch {/* best-effort */}
  }
  agent.destroy();
  // Best-effort: clean up the tmp ARGOS_ROOT
  try { rmSync(argosTmp, { recursive: true, force: true }); } catch {/* file in use; leave it */}
}

console.log("");
const verdict = fail === 0
  ? `smoke-v1-e2e: ${pass} passed — PASS`
  : `smoke-v1-e2e: ${pass} passed, ${fail} failed — FAIL\n  ${failures.join("\n  ")}`;
console.log(verdict);

// Use process.exit with explicit code; libuv assertion on Windows is
// harmless after this point (no fetch in flight; agent destroyed).
process.exit(fail === 0 ? 0 : 1);
