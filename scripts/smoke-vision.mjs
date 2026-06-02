#!/usr/bin/env node
// smoke-vision.mjs — Vision Phase 1 (2026-06-02) gate.
//
// Verifies the vision routing + features end to end:
//   1. /api/vision/status GET returns the correct shape (ok/model/available/
//      features).
//   2. Vision model routing (the production resolveChatModel, exercised via the
//      /api/vision/status POST probe): image → gemma4-turbo, text → persona
//      model. Both directions.
//   3. Image base64 encode/decode round-trip (pure node — byte-exact).
//   4. Screenshot API: advertised by status.features.screenshot. (getDisplayMedia
//      is browser-only; node can't exercise it — we assert it's offered and
//      note the runtime detection is client-side.)
//   5. Vault image upload + description: POST a real PNG → image is described by
//      gemma4-turbo and ingested as searchable text (kind:"image", non-empty
//      description). Cleaned up after.
//   6. End-to-end chat routing: POST /api/chat with an image → response headers
//      x-vision-model = gemma4-turbo, x-vision-used = true (reuses the warm
//      model from step 5).
//
// Requires a live Ollama with ssfdre38/gemma4-turbo:e4b pulled. Spawns its own
// `next start` server, so the repo must be built first (npm run build).
//
// Usage: node scripts/smoke-vision.mjs [--port 7822]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import zlib from "node:zlib";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7822;

const VISION_MODEL = "ssfdre38/gemma4-turbo:e4b";
const PERSONA_MODEL = "royhodge812/Orchestrator:lates"; // Bart's text model

let pass = 0,
  fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`);
  }
}

// ---------- minimal, version-safe PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
// 64×64: red top half, blue bottom half — easy for the model to describe.
const PNG = makePng(64, 64, (x, y) => (y < 32 ? [220, 30, 30] : [30, 30, 220]));

// ---------- http helpers (node:http, no keepalive) ----------
function jreq(base, path, opts = {}) {
  return new Promise((res) => {
    let url;
    try {
      url = new URL(path, base);
    } catch (e) {
      res({ ok: false, error: e.message });
      return;
    }
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: opts.headers || {},
        timeout: opts.timeoutMs || 30_000,
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString("utf8"));
          } catch {
            /* not json */
          }
          res({ ok: true, status: resp.statusCode, headers: resp.headers, buf, json });
        });
      }
    );
    r.on("error", (e) => res({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// POST /api/chat and resolve as soon as response HEADERS arrive, then abort —
// we only need the routing decision (x-vision-*), not the (slow) generation.
function chatHeaders(base, payload, timeoutMs = 120_000) {
  return new Promise((res) => {
    const url = new URL("/api/chat", base);
    const body = Buffer.from(JSON.stringify(payload));
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { "content-type": "application/json", "content-length": body.length },
        timeout: timeoutMs,
      },
      (resp) => {
        const headers = resp.headers;
        const status = resp.statusCode;
        resp.destroy(); // abort the stream; we have the headers
        res({ ok: true, status, headers });
      }
    );
    r.on("error", (e) => res({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.write(body);
    r.end();
  });
}

// POST a multipart/form-data image to /api/vault/upload, collect NDJSON events.
function uploadImage(base, buf, filename, timeoutMs = 200_000) {
  return new Promise((res) => {
    const url = new URL("/api/vault/upload", base);
    const boundary = "----argosvision" + Date.now().toString(16);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buf, tail]);
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": body.length,
        },
        timeout: timeoutMs,
      },
      (resp) => {
        let raw = "";
        const events = [];
        resp.on("data", (c) => {
          raw += c.toString("utf8");
          let nl = raw.indexOf("\n");
          while (nl !== -1) {
            const line = raw.slice(0, nl).trim();
            raw = raw.slice(nl + 1);
            if (line) {
              try {
                events.push(JSON.parse(line));
              } catch {
                /* skip */
              }
            }
            nl = raw.indexOf("\n");
          }
        });
        resp.on("end", () => res({ ok: true, status: resp.statusCode, events }));
      }
    );
    r.on("error", (e) => res({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.write(body);
    r.end();
  });
}

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await jreq(base, "/api/vision/status", { timeoutMs: 4000 });
    if (r.ok && r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

async function withServer(label, port, fn) {
  console.log(`\n[boot] ${label} — next start :${port}`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    {
      cwd: repoRoot,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: repoRoot },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready");
    await fn(base);
  } finally {
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]);
      else server.kill("SIGKILL");
    } catch {
      /* best effort */
    }
  }
}

try {
  await withServer("vision", BASE_PORT, async (base) => {
    // ===== 1. status shape =====
    console.log("\n=== 1. /api/vision/status — shape ===");
    const st = await jreq(base, "/api/vision/status");
    check("status 200", st.ok && st.status === 200, `(${st.status})`);
    check("ok === true", st.json?.ok === true);
    check("model is gemma4-turbo", st.json?.model === VISION_MODEL, `(${st.json?.model})`);
    check(
      "features present (imageDrop/fileVision/screenshot)",
      st.json?.features &&
        st.json.features.imageDrop === true &&
        st.json.features.fileVision === true &&
        st.json.features.screenshot === true
    );
    check("model available in ollama", st.json?.available === true, `(available=${st.json?.available})`);

    // ===== 2. routing probe — image vs text =====
    console.log("\n=== 2. vision routing (resolveChatModel probe) ===");
    const imgRoute = await jreq(base, "/api/vision/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hasImages: true, personaModel: PERSONA_MODEL }),
    });
    check(
      "image → gemma4-turbo",
      imgRoute.json?.model === VISION_MODEL && imgRoute.json?.vision === true,
      `(model=${imgRoute.json?.model}, vision=${imgRoute.json?.vision})`
    );
    const txtRoute = await jreq(base, "/api/vision/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hasImages: false, personaModel: PERSONA_MODEL }),
    });
    check(
      "text → persona model",
      txtRoute.json?.model === PERSONA_MODEL && txtRoute.json?.vision === false,
      `(model=${txtRoute.json?.model}, vision=${txtRoute.json?.vision})`
    );
    const msgRoute = await jreq(base, "/api/vision/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi", images: ["AAAA"] }],
        personaModel: PERSONA_MODEL,
      }),
    });
    check(
      "messages-with-image → gemma4-turbo",
      msgRoute.json?.model === VISION_MODEL && msgRoute.json?.vision === true,
      `(vision=${msgRoute.json?.vision})`
    );

    // ===== 3. base64 round-trip =====
    console.log("\n=== 3. image base64 round-trip ===");
    const b64 = PNG.toString("base64");
    const back = Buffer.from(b64, "base64");
    check(
      "base64 encode/decode is byte-exact",
      back.length === PNG.length && back.equals(PNG),
      `(${PNG.length} bytes)`
    );
    check("decoded PNG has valid signature", back[0] === 0x89 && back[1] === 0x50);

    // ===== 4. screenshot API advertisement =====
    console.log("\n=== 4. screenshot capability ===");
    check(
      "status advertises screenshot feature",
      st.json?.features?.screenshot === true
    );
    console.log(
      "  [note] getDisplayMedia is browser-only — runtime availability is detected client-side (screenshotSupported)."
    );

    // ===== 5. vault image upload + description =====
    console.log("\n=== 5. vault image upload → vision description ===");
    const t0 = Date.now();
    const up = await uploadImage(base, PNG, `smoke-vision-${Date.now()}.png`);
    const done = up.events?.find((e) => e.stage === "done");
    const errEvt = up.events?.find((e) => e.stage === "error");
    if (errEvt) console.log(`  [note] upload error event: ${errEvt.error}`);
    check("upload completed (stage:done)", !!done, errEvt ? `(error: ${errEvt.error})` : "");
    const docId = done?.result?.docId ?? null;
    check("ingest produced a docId", !!docId, `(${docId})`);
    console.log(`  [latency] image describe + ingest: ${Date.now() - t0} ms`);

    let listed = null;
    if (docId) {
      const list = await jreq(base, "/api/vault/list");
      listed = list.json?.documents?.find((d) => d.id === docId) ?? null;
      check("doc listed as kind:image", listed?.kind === "image", `(kind=${listed?.kind})`);
      check(
        "vision description is non-empty",
        typeof listed?.description === "string" && listed.description.trim().length > 0,
        listed?.description ? `("${listed.description.slice(0, 60)}…")` : ""
      );
      // cleanup
      await jreq(base, "/api/vault/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId }),
      });
      console.log("  [cleanup] removed test image from vault");
    }

    // ===== 6. end-to-end chat routing (headers) =====
    console.log("\n=== 6. /api/chat routes image turn to gemma4-turbo ===");
    const ch = await chatHeaders(base, {
      messages: [
        { role: "user", content: "Name the two colors. Two words.", images: [PNG.toString("base64")] },
      ],
      personaId: "bartimaeus",
      model: PERSONA_MODEL,
    });
    check("chat responded 200", ch.ok && ch.status === 200, `(${ch.status ?? ch.error})`);
    check(
      "x-vision-model header = gemma4-turbo",
      ch.headers?.["x-vision-model"] === VISION_MODEL,
      `(${ch.headers?.["x-vision-model"]})`
    );
    check("x-vision-used header = true", ch.headers?.["x-vision-used"] === "true");
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
}

console.log(`\nsmoke-vision: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
