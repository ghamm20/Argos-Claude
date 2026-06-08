#!/usr/bin/env node
// smoke-phase-a.mjs (v2.4.2 Phase A) — inference backend switch + rebound models.
//
// Exercises BOTH backends via the /api/chat response headers
// (x-inference-backend / x-inference-model / x-inference-fallback):
//   T1. Settings store nousApiKey (masked on read-back, raw key NEVER echoed)
//       + inferenceBackend + perPersonaBackend + useReboundModels.
//   T2. backend=local (default) → Bart answers locally; header backend=local,
//       model=Bart's local model, fallback=none.
//   T3. backend=nous + a FAKE key → Nous 401s → SILENT fallback to local
//       (header backend=local, fallback starts with "nous_error"); NOT a 503.
//   T4. backend=nous + NO key → fallback to local, fallback="nous_key_missing".
//   T5. useReboundModels=true → Juniper's call runs the LOCAL gemma-4 model
//       (header model = the rebound model), proving the rebind is a local swap.
//   T6. (opt-in) Set ARGOS_NOUS_TEST_KEY to a real Nous key → backend=nous,
//       model="nvidia/nemotron-3-ultra:free". Skipped (honestly) when unset —
//       we never fabricate a "nous answered" result without a real call.
//
// Isolation: a throwaway ARGOS_ROOT so the operator's settings.json is
// untouched. Uses the host's real Ollama (127.0.0.1:11434) for the local turns,
// exactly like auth-smoke. No real Nous key required for T1-T5.
//
// Usage: node scripts/smoke-phase-a.mjs [--port 7884]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7884;
const ROOT = join(tmpdir(), `argos-phasea-${process.pid}`);

// Model strings (NOT paths — Rule 1 only forbids absolute filesystem paths).
const BART_MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";
const JUNIPER_MODEL = "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b";
const REBOUND_MODEL = "aratan/gemma-4-E4B-q8-it-heretic:latest";
const NOUS_MODEL = "nvidia/nemotron-3-ultra:free";
const FAKE_KEY = "sk-nous-phasea-smoke-fake-not-real";

let pass = 0,
  fail = 0;
const check = (n, c, d = "") => {
  if (c) {
    pass++;
    console.log(`  [PASS] ${n}${d ? "  " + d : ""}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`);
  }
};

function postJson(path, payload) {
  return new Promise((res) => {
    const url = new URL(path, `http://127.0.0.1:${PORT}`);
    const body = Buffer.from(JSON.stringify(payload));
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
        },
        timeout: 60000,
      },
      (resp) => {
        const c = [];
        resp.on("data", (x) => c.push(x));
        resp.on("end", () =>
          res({ status: resp.statusCode, headers: resp.headers, bytes: Buffer.concat(c) })
        );
      }
    );
    r.on("error", () => res({ status: 0, headers: {} }));
    r.on("timeout", () => {
      r.destroy();
      res({ status: 0, headers: {} });
    });
    r.write(body);
    r.end();
  });
}

// Chat POST that resolves on RESPONSE HEADERS (which the route sends only after
// the upstream call succeeds), then destroys the stream — we assert the backend
// from headers without waiting for the full generation.
function chatHeaders(personaId, model) {
  return new Promise((res) => {
    const url = new URL("/api/chat", `http://127.0.0.1:${PORT}`);
    const body = Buffer.from(
      JSON.stringify({
        messages: [{ role: "user", content: "Say hello in one short sentence." }],
        personaId,
        model,
        useRetrieval: false,
      })
    );
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
        },
        timeout: 90000,
      },
      (resp) => {
        const out = { status: resp.statusCode, headers: resp.headers };
        resp.destroy(); // we only need the headers
        res(out);
      }
    );
    r.on("error", () => res({ status: 0, headers: {} }));
    r.on("timeout", () => {
      r.destroy();
      res({ status: 0, headers: {} });
    });
    r.write(body);
    r.end();
  });
}

function getJson(path) {
  return new Promise((res) => {
    http
      .get(new URL(path, `http://127.0.0.1:${PORT}`), (r) => {
        const c = [];
        r.on("data", (x) => c.push(x));
        r.on("end", () => {
          try {
            res(JSON.parse(Buffer.concat(c).toString("utf8")));
          } catch {
            res(null);
          }
        });
      })
      .on("error", () => res(null));
  });
}

async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => {
      http
        .get(new URL("/api/runtime", `http://127.0.0.1:${PORT}`), (r) => {
          r.resume();
          res(r.statusCode === 200);
        })
        .on("error", () => res(false));
    });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(
  process.execPath,
  [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  {
    cwd: repoRoot,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);
server.stdout.on("data", () => {});
server.stderr.on("data", () => {});

const hdr = (r, k) => r.headers?.[k] ?? "";

try {
  if (!(await ready())) throw new Error("server not ready");
  console.log(`[ready] smoke-phase-a (local Ollama for the local turns)\n`);

  console.log("=== Test 1 — settings store inference config (Nous key masked) ===");
  const t1 = await postJson("/api/settings", {
    nousApiKey: FAKE_KEY,
    inferenceBackend: "nous",
    useReboundModels: true,
    perPersonaBackend: { juniper: "local" },
  });
  check("1a: POST /api/settings accepted (200)", t1.status === 200, `status=${t1.status}`);
  const s = await getJson("/api/settings");
  check(
    "1b: read-back shows nousApiKey configured:true",
    s?.nousApiKey?.configured === true,
    JSON.stringify(s?.nousApiKey ?? null)
  );
  check(
    "1c: read-back NEVER returns the raw Nous key",
    JSON.stringify(s ?? {}).indexOf(FAKE_KEY) === -1,
    "key absent from response"
  );
  check(
    "1d: inferenceBackend + useReboundModels + perPersona stored",
    s?.inferenceBackend === "nous" &&
      s?.useReboundModels === true &&
      s?.perPersonaBackend?.juniper === "local"
  );

  console.log("\n=== Test 2 — backend=local → Bart answers locally ===");
  await postJson("/api/settings", {
    inferenceBackend: "local",
    useReboundModels: false,
    perPersonaBackend: {},
    nousApiKey: null,
  });
  const t2 = await chatHeaders("bartimaeus", BART_MODEL);
  check(
    "2: 200, backend=local, model=local, fallback=none",
    t2.status === 200 &&
      hdr(t2, "x-inference-backend") === "local" &&
      hdr(t2, "x-inference-model") === BART_MODEL &&
      hdr(t2, "x-inference-fallback") === "none",
    `status=${t2.status} backend=${hdr(t2, "x-inference-backend")} model=${hdr(t2, "x-inference-model")} fb=${hdr(t2, "x-inference-fallback")}`
  );

  console.log("\n=== Test 3 — backend=nous + FAKE key → SILENT local fallback ===");
  await postJson("/api/settings", { inferenceBackend: "nous", nousApiKey: FAKE_KEY });
  const t3 = await chatHeaders("bartimaeus", BART_MODEL);
  check(
    "3: 200 (not 503), backend=local, fallback=nous_error:*",
    t3.status === 200 &&
      hdr(t3, "x-inference-backend") === "local" &&
      /^nous_error:/.test(hdr(t3, "x-inference-fallback")),
    `status=${t3.status} backend=${hdr(t3, "x-inference-backend")} fb=${hdr(t3, "x-inference-fallback")}`
  );

  console.log("\n=== Test 4 — backend=nous + NO key → fallback=nous_key_missing ===");
  await postJson("/api/settings", { inferenceBackend: "nous", nousApiKey: null });
  const t4 = await chatHeaders("bartimaeus", BART_MODEL);
  check(
    "4: 200, backend=local, fallback=nous_key_missing",
    t4.status === 200 &&
      hdr(t4, "x-inference-backend") === "local" &&
      hdr(t4, "x-inference-fallback") === "nous_key_missing",
    `status=${t4.status} backend=${hdr(t4, "x-inference-backend")} fb=${hdr(t4, "x-inference-fallback")}`
  );

  console.log("\n=== Test 5 — useReboundModels=true → Juniper runs local gemma-4 ===");
  await postJson("/api/settings", {
    inferenceBackend: "local",
    useReboundModels: true,
    nousApiKey: null,
  });
  const t5 = await chatHeaders("juniper", JUNIPER_MODEL);
  check(
    "5: 200, backend=local, model=rebound gemma-4 (not Juniper's own model)",
    t5.status === 200 &&
      hdr(t5, "x-inference-backend") === "local" &&
      hdr(t5, "x-inference-model") === REBOUND_MODEL,
    `status=${t5.status} model=${hdr(t5, "x-inference-model")}`
  );

  console.log("\n=== Test 6 — (opt-in) live Nous backend ===");
  const liveKey = process.env.ARGOS_NOUS_TEST_KEY;
  if (!liveKey) {
    console.log(
      "  [skip] live Nous test — set ARGOS_NOUS_TEST_KEY to a real key to run (not fabricating a nous result without a real call)"
    );
  } else {
    await postJson("/api/settings", {
      inferenceBackend: "nous",
      useReboundModels: false,
      nousApiKey: liveKey,
    });
    const t6 = await chatHeaders("bartimaeus", BART_MODEL);
    check(
      "6: 200, backend=nous, model=nvidia/nemotron-3-ultra:free",
      t6.status === 200 &&
        hdr(t6, "x-inference-backend") === "nous" &&
        hdr(t6, "x-inference-model") === NOUS_MODEL,
      `status=${t6.status} backend=${hdr(t6, "x-inference-backend")} model=${hdr(t6, "x-inference-model")}`
    );
  }
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
    else server.kill("SIGKILL");
  } catch {
    /* */
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* */
  }
}

console.log(`\nsmoke-phase-a: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
