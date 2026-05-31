#!/usr/bin/env node
// Smoke test for the H2 streaming chat path against a live Ollama daemon.
// Captures TTFT, total tokens, tokens/sec, and any parse errors.
//
// Wire transport: node:http (not fetch). Global fetch/undici keepAlive trips
// a libuv assertion (UV_HANDLE_CLOSING) on process teardown on Windows node
// 24 — avoidable by sticking to http.request + agent.destroy() at end of
// smoke. The NDJSON stream is parsed incrementally off res "data" events so
// the token-level TTFT measurement is preserved.

import http from "node:http";

const URL_ = process.env.SMOKE_URL || "http://localhost:3000/api/chat";
const PERSONA = process.env.SMOKE_PERSONA || "bartimaeus";
const PROMPT =
  process.env.SMOKE_PROMPT || "Hello, identify yourself in one sentence.";

const agent = new http.Agent({ keepAlive: false });

// GET + JSON-parse over node:http (same no-keepalive transport as the rest).
function getJson(targetUrl, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const r = http.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.end();
  });
}

// Resolve the chat model dynamically from the live server (/api/settings →
// defaultModel) so the smoke tracks the configured roster instead of a
// hardcoded literal that rots when the roster changes. defaultModel is
// validated-on-write against the allowed model list, so it's always a model
// /api/chat will accept. SMOKE_MODEL still overrides.
async function resolveModel() {
  const origin = new URL(URL_).origin;
  const settings = await getJson(`${origin}/api/settings`);
  const picked = settings?.defaultModel;
  if (!picked) {
    throw new Error("could not resolve defaultModel from /api/settings");
  }
  return picked;
}

const MODEL = process.env.SMOKE_MODEL || (await resolveModel());

const t0 = performance.now();
let ttft = null;
let liveTokens = 0;
let parseErrors = 0;
let finalEvalCount = 0;
let finalEvalDurationNs = 0;
let finalPromptEvalCount = 0;
let firstLineSnippet = "";
let lastChunk = "";
let httpFirstByteAt = null;
let httpStatus = 0;
let httpContentType = "";

const payload = JSON.stringify({
  messages: [{ role: "user", content: PROMPT }],
  personaId: PERSONA,
  model: MODEL,
});

await new Promise((resolve, reject) => {
  const u = new URL(URL_);
  const req = http.request(
    {
      method: "POST",
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { "content-type": "application/json" },
      agent,
      timeout: 180_000,
    },
    (res) => {
      // res callback fires when response headers arrive — the analog of
      // fetch() resolving, i.e. our "first byte".
      httpFirstByteAt = performance.now();
      httpStatus = res.statusCode;
      httpContentType = res.headers["content-type"] ?? "";
      res.setEncoding("utf8");

      if (!(res.statusCode >= 200 && res.statusCode < 300)) {
        let errBody = "";
        res.on("data", (c) => {
          errBody += c;
        });
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
        return;
      }

      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            if (!firstLineSnippet) firstLineSnippet = line.slice(0, 200);
            try {
              const obj = JSON.parse(line);
              if (obj.message?.content) {
                if (ttft === null) ttft = performance.now() - t0;
                liveTokens++;
                lastChunk = obj.message.content;
              }
              if (obj.done) {
                finalEvalCount = obj.eval_count ?? 0;
                finalEvalDurationNs = obj.eval_duration ?? 0;
                finalPromptEvalCount = obj.prompt_eval_count ?? 0;
              }
            } catch {
              parseErrors++;
            }
          }
          nl = buf.indexOf("\n");
        }
      });
      res.on("end", resolve);
    }
  );
  req.on("error", reject);
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.write(payload);
  req.end();
}).catch((e) => {
  console.error(e.message);
  agent.destroy();
  process.exit(1);
});

console.log(
  `HTTP_OK status=${httpStatus} content-type=${httpContentType}`
);

const totalMs = performance.now() - t0;
const httpFirstByteMs = httpFirstByteAt - t0;
const ollamaTps =
  finalEvalDurationNs > 0
    ? finalEvalCount / (finalEvalDurationNs / 1e9)
    : 0;
const livePostFirst =
  ttft !== null && totalMs > ttft ? (totalMs - ttft) / 1000 : 0;
const liveTps = livePostFirst > 0 ? liveTokens / livePostFirst : 0;

console.log(`MODEL                   ${MODEL}`);
console.log(`PERSONA                 ${PERSONA}`);
console.log(`PROMPT                  ${PROMPT}`);
console.log(`HTTP_FIRST_BYTE_MS      ${httpFirstByteMs.toFixed(1)}`);
console.log(`TTFT_MS_TOKEN_LEVEL     ${ttft === null ? "(none)" : ttft.toFixed(1)}`);
console.log(`TOTAL_DURATION_MS       ${totalMs.toFixed(1)}`);
console.log(`OLLAMA_EVAL_COUNT       ${finalEvalCount}`);
console.log(`OLLAMA_PROMPT_TOKENS    ${finalPromptEvalCount}`);
console.log(`OLLAMA_TPS              ${ollamaTps.toFixed(2)}`);
console.log(`LIVE_TOKEN_COUNT        ${liveTokens}`);
console.log(`LIVE_TPS                ${liveTps.toFixed(2)}`);
console.log(`PARSE_ERRORS            ${parseErrors}`);
console.log(`FIRST_LINE_SNIPPET      ${firstLineSnippet}`);
console.log(`LAST_CHUNK              ${JSON.stringify(lastChunk)}`);

agent.destroy();
process.exit(parseErrors === 0 && finalEvalCount > 0 ? 0 : 1);
