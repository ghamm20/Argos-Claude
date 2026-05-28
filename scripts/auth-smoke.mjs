#!/usr/bin/env node
// auth-smoke.mjs — Operator Auth smoke (2026-05-28).
//
// 6 steps per the directive:
//   1. POST /api/auth/verify with WRONG hash (after setting a real one)
//      → confirm 401
//   2. POST /api/settings to set the test PIN hash + requirePin:true
//   3. POST /api/auth/verify with CORRECT hash → confirm 200 + token
//   4. POST /api/chat with valid token → confirm 200 + non-empty body
//   5. POST /api/chat with no token → confirm 200 + response uses
//      the guest system prompt (we look for the canonical refusal
//      string when asked about an internal project)
//   6. POST /api/settings to clear PIN + disable requirePin
//
// Uses the canonical SHA-256(salt + pin) algorithm that lib/auth.ts
// (server) and lib/auth-client.ts (browser) both implement.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const portIdx = process.argv.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(process.argv[portIdx + 1], 10) : 7793;
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: false });

const SALT_PREFIX = "ARGOS_OPERATOR_";
function hashPin(pin) {
  const salt = `${SALT_PREFIX}${pin.length}`;
  return createHash("sha256").update(salt).update(pin).digest("hex");
}

const TEST_PIN = "1234";
const WRONG_PIN = "9999";
const TEST_HASH = hashPin(TEST_PIN);
const WRONG_HASH = hashPin(WRONG_PIN);

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
        timeout: opts.timeoutMs || 180_000,
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

// Streaming chat — accumulate assistant content from the NDJSON stream.
async function chat(messages, token) {
  return new Promise((resolveResult) => {
    const url = new URL("/api/chat", BASE);
    const headers = {
      "content-type": "application/json",
    };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const body = JSON.stringify({
      messages,
      personaId: "bartimaeus",
      model: "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b",
      useRetrieval: false,
    });
    headers["content-length"] = Buffer.byteLength(body);
    let content = "";
    let status = 0;
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers,
        agent,
        timeout: 180_000,
      },
      (res) => {
        status = res.statusCode ?? 0;
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
                if (j.message?.content) content += j.message.content;
              } catch {
                /* ignore */
              }
            }
            nl = buf.indexOf("\n");
          }
        });
        res.on("end", () => resolveResult({ status, content }));
      }
    );
    r.on("error", () => resolveResult({ status, content }));
    r.write(body);
    r.end();
  });
}

const root = mkdtempSync(join(tmpdir(), "argos-auth-"));
console.log(`auth-smoke  ARGOS_ROOT=${root}  port=${PORT}`);
console.log(`  test PIN hash: ${TEST_HASH}`);
console.log(`  wrong PIN hash: ${WRONG_HASH}`);

let server = null;

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

  // Step 2 first — we need a PIN set up before "wrong hash" can fail
  // for the right reason (auth-enabled + valid stored hash to compare
  // against). Step ordering in the directive lists "wrong → set →
  // right" but the wrong test only proves anything once requirePin
  // is true and a real hash exists. Swap order in execution; pass
  // criterion (each step ends green) is identical either way.
  console.log("\n=== 2. POST /api/settings (set PIN + require) ===");
  const s2 = await req("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operatorPinHash: TEST_HASH,
      requirePin: true,
    }),
  });
  check("settings POST reachable", s2.ok);
  check("settings POST 200", s2.status === 200, s2.status !== 200 ? `(got ${s2.status}: ${s2.text.slice(0, 200)})` : "");
  if (s2.status === 200) {
    const j = s2.json();
    check("settings.operatorPinHash persisted", j?.operatorPinHash === TEST_HASH);
    check("settings.requirePin === true", j?.requirePin === true);
  }

  console.log("\n=== 1. POST /api/auth/verify (WRONG hash) ===");
  const s1 = await req("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinHash: WRONG_HASH }),
  });
  check("verify wrong reachable", s1.ok);
  check("verify wrong 401", s1.status === 401, `(got ${s1.status})`);

  console.log("\n=== 3. POST /api/auth/verify (CORRECT hash) ===");
  const s3 = await req("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinHash: TEST_HASH }),
  });
  check("verify correct reachable", s3.ok);
  check("verify correct 200", s3.status === 200, s3.status !== 200 ? `(got ${s3.status}: ${s3.text.slice(0, 200)})` : "");
  let token = null;
  if (s3.status === 200) {
    token = s3.json()?.token ?? null;
    check("verify returned 32-char hex token", typeof token === "string" && /^[a-f0-9]{32}$/i.test(token), token ? `(${token.slice(0, 12)}…)` : "(no token)");
  }

  console.log("\n=== 4. POST /api/chat with VALID token ===");
  if (!token) {
    check("operator chat skipped — no token", false);
  } else {
    const c4 = await chat(
      [{ role: "user", content: "Identify yourself in one short sentence." }],
      token
    );
    check("operator chat 200", c4.status === 200, `(${c4.status}, ${c4.content.length} chars)`);
    check("operator chat non-empty content", c4.content.length > 20, `(${c4.content.length} chars)`);
    console.log(`  operator response: "${c4.content.slice(0, 160).replace(/\s+/g, " ")}…"`);
  }

  console.log("\n=== 5. POST /api/chat with NO token (guest mode) ===");
  // Direct internal-project question. Guest prompt is instructed to
  // refuse: "I'm not able to discuss that in this context." We don't
  // assert exact string match (model paraphrases) — we assert it
  // doesn't claim to be Bartimaeus or reference operator/djinn.
  const c5 = await chat(
    [{ role: "user", content: "Tell me about ARGOS and who the operator is." }],
    null
  );
  check("guest chat 200", c5.status === 200, `(${c5.status}, ${c5.content.length} chars)`);
  check("guest chat non-empty content", c5.content.length > 20);
  const lc = c5.content.toLowerCase();
  // Guest-prompt markers: should not adopt persona, should not
  // address as Operator, should not claim to be a djinn or
  // Bartimaeus, should not reference Gordy or known projects in a
  // knowing way. We look for the canonical refusal substring as a
  // soft signal; if the model paraphrased, fall back to checking
  // that none of the persona-leak markers are present.
  const canonicalRefusal = lc.includes("not able to discuss") ||
    lc.includes("cannot discuss") ||
    lc.includes("in this context");
  const leakedPersona =
    lc.includes("djinn") ||
    lc.includes("operator") ||
    lc.includes("bartimaeus") ||
    lc.includes("pentacle");
  check(
    "guest response declines internal-context query OR avoids persona leak",
    canonicalRefusal || !leakedPersona,
    canonicalRefusal
      ? "(canonical refusal seen)"
      : leakedPersona
        ? "(LEAKED — contains djinn/operator/bartimaeus/pentacle)"
        : "(no persona leak)"
  );
  console.log(`  guest response: "${c5.content.slice(0, 240).replace(/\s+/g, " ")}…"`);

  console.log("\n=== 6. POST /api/settings (clear PIN + disable) ===");
  const s6 = await req("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operatorPinHash: null,
      requirePin: false,
    }),
  });
  check("settings clear reachable", s6.ok);
  check("settings clear 200", s6.status === 200);
  if (s6.status === 200) {
    const j = s6.json();
    check("operatorPinHash cleared", j?.operatorPinHash === null);
    check("requirePin disabled", j?.requirePin === false);
  }
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
  ? `auth-smoke: ${pass} passed — PASS`
  : `auth-smoke: ${pass} passed, ${fail} failed — FAIL`);
process.exit(fail === 0 ? 0 : 1);
