#!/usr/bin/env node
// phase9-memory-smoke.mjs — Phase 9 (2026-05-27) memory smoke.
//
// Spawns ARGOS in a tmp ARGOS_ROOT and exercises the memory API:
//
//   1. POST /api/memory/profile with the seed payload → confirm 200
//   2. POST /api/memory/write with a test entry → confirm 200, capture id
//   3. GET  /api/memory/list?persona=bartimaeus → entry appears
//   4. GET  /api/memory/profile → seeded operator profile present
//   5. DELETE /api/memory/prune?id=<id> → 200
//   6. GET  /api/memory/list?persona=bartimaeus → pruned entry not in results
//   7. POST /api/chat through Bart → 200, content non-empty (memory
//      retrieval/extraction wired without breaking chat)
//
// Exit 0 = PASS; 1 = FAIL. Each step prints [ok ] / [FAIL].

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const portIdx = process.argv.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(process.argv[portIdx + 1], 10) : 7795;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

let pass = 0;
let fail = 0;
function check(label, cond, detail = "") {
  const tag = cond ? "[ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (cond) pass++;
  else fail++;
}

function req(path, opts = {}) {
  return new Promise((resolveResult) => {
    const url = new URL(path, BASE);
    const body = opts.body ?? null;
    const headers = { ...(opts.headers || {}) };
    if (body && !headers["content-length"]) {
      headers["content-length"] = Buffer.byteLength(body);
    }
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
        agent,
        timeout: opts.timeoutMs || 120_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolveResult({
            ok: true,
            status: res.statusCode,
            text: buf.toString("utf8"),
            json: () => {
              try {
                return JSON.parse(buf.toString("utf8"));
              } catch {
                return null;
              }
            },
          });
        });
      }
    );
    r.on("error", (e) => resolveResult({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

async function waitReady(maxSec = 45) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req("/api/voice/status");
    if (r.ok && r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

const root = mkdtempSync(join(tmpdir(), "argos-phase9-"));
console.log(`phase9-memory-smoke  ARGOS_ROOT=${root}  port=${PORT}`);

let server = null;
let testEntryId = null;

try {
  console.log(`\n[boot] starting next start on port ${PORT}`);
  server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, ARGOS_ROOT: root, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  if (!(await waitReady(45))) throw new Error("server failed to come up");
  console.log("[boot] ready");

  // Step 1 — seed operator profile via API.
  console.log("\n=== 1. POST /api/memory/profile (seed) ===");
  const seedPayload = {
    name: "Gordy",
    role: "Security Executive / Operator — EKG Security, COO.",
    context:
      "Building ARGOS — USB-native local AI workstation with 4 personas.",
    preferences: {
      response_style: "Direct. Short sentences. No preamble.",
      honesty: "Brutal honesty over agreement.",
    },
  };
  const s1 = await req("/api/memory/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(seedPayload),
  });
  check("profile seed reachable", s1.ok);
  check("profile seed 200", s1.status === 200, s1.status !== 200 ? `(got ${s1.status}: ${s1.text.slice(0, 200)})` : "");

  // Step 2 — write a test memory.
  console.log("\n=== 2. POST /api/memory/write (test entry) ===");
  const writeBody = {
    persona_id: "bartimaeus",
    tier: "short_term",
    content: "Smoke test entry for phase9-memory-smoke.",
    importance: 0.5,
    tags: ["smoke", "phase9"],
  };
  const s2 = await req("/api/memory/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(writeBody),
  });
  check("write reachable", s2.ok);
  check("write 200", s2.status === 200, s2.status !== 200 ? `(got ${s2.status}: ${s2.text.slice(0, 200)})` : "");
  if (s2.status === 200) {
    const j = s2.json();
    testEntryId = j?.entry?.id ?? null;
    check("write returned entry.id", typeof testEntryId === "string" && testEntryId.length > 0, `id=${testEntryId ?? "(none)"}`);
  }

  // Step 3 — list, confirm entry appears.
  console.log("\n=== 3. GET /api/memory/list (bartimaeus) ===");
  const s3 = await req("/api/memory/list?persona=bartimaeus");
  check("list reachable", s3.ok);
  check("list 200", s3.status === 200);
  if (s3.status === 200) {
    const entries = s3.json()?.entries ?? [];
    const found = entries.find((e) => e.id === testEntryId);
    check("test entry present in list", !!found, found ? `(content="${found.content.slice(0, 40)}…")` : "(not found)");
  }

  // Step 4 — profile present.
  console.log("\n=== 4. GET /api/memory/profile ===");
  const s4 = await req("/api/memory/profile");
  check("profile reachable", s4.ok);
  check("profile 200", s4.status === 200);
  if (s4.status === 200) {
    const profile = s4.json()?.profile ?? null;
    check("operator profile.name = Gordy", profile?.name === "Gordy", profile?.name ? `(name="${profile.name}")` : "");
    check("operator profile.preferences has response_style", typeof profile?.preferences?.response_style === "string");
  }

  // Step 5 — prune.
  console.log("\n=== 5. DELETE /api/memory/prune ===");
  if (!testEntryId) {
    check("prune skipped — no test entry id", false);
  } else {
    const s5 = await req(`/api/memory/prune?id=${encodeURIComponent(testEntryId)}`, { method: "DELETE" });
    check("prune reachable", s5.ok);
    check("prune 200", s5.status === 200, s5.status !== 200 ? `(got ${s5.status}: ${s5.text.slice(0, 200)})` : "");
  }

  // Step 6 — list again, confirm pruned entry gone.
  console.log("\n=== 6. GET /api/memory/list (after prune) ===");
  const s6 = await req("/api/memory/list?persona=bartimaeus");
  check("list 200", s6.status === 200);
  if (s6.status === 200) {
    const entries = s6.json()?.entries ?? [];
    const stillThere = entries.find((e) => e.id === testEntryId);
    check("pruned entry NOT in results", !stillThere, stillThere ? "(still present — prune failed)" : "");
  }

  // Step 7 — chat still works with memory wired.
  console.log("\n=== 7. POST /api/chat (memory injection doesn't break chat) ===");
  const chatBody = {
    messages: [{ role: "user", content: "Identify yourself in one sentence." }],
    personaId: "bartimaeus",
    model: "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b",
    useRetrieval: false,
  };
  const t0 = Date.now();
  let chatStatus = 0;
  let chatChars = 0;
  await new Promise((resolveResult) => {
    const url = new URL("/api/chat", BASE);
    const body = JSON.stringify(chatBody);
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        agent,
        timeout: 180_000,
      },
      (res) => {
        chatStatus = res.statusCode ?? 0;
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              try {
                const j = JSON.parse(line);
                if (j.message?.content) chatChars += j.message.content.length;
              } catch {
                /* ignore */
              }
            }
            nl = buf.indexOf("\n");
          }
        });
        res.on("end", resolveResult);
      }
    );
    r.on("error", resolveResult);
    r.write(body);
    r.end();
  });
  const wall = Date.now() - t0;
  check("chat 200", chatStatus === 200, `(${chatStatus}, ${chatChars} chars, ${wall}ms)`);
  check("chat returned non-empty content", chatChars > 20, `(${chatChars} chars)`);
} catch (e) {
  fail++;
  console.log(`\n[fatal] ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  if (server && !server.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      } else {
        server.kill("SIGTERM");
      }
    } catch {}
  }
  agent.destroy();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log("");
console.log(fail === 0
  ? `phase9-memory-smoke: ${pass} passed — PASS`
  : `phase9-memory-smoke: ${pass} passed, ${fail} failed — FAIL`);
process.exit(fail === 0 ? 0 : 1);
