#!/usr/bin/env node
// Smoke test for the H2 streaming chat path against a live Ollama daemon.
// Captures TTFT, total tokens, tokens/sec, and any parse errors.

const URL = process.env.SMOKE_URL || "http://localhost:3000/api/chat";
const MODEL = process.env.SMOKE_MODEL || "llama3.1:8b-instruct-q4_K_M";
const PERSONA = process.env.SMOKE_PERSONA || "bartimaeus";
const PROMPT =
  process.env.SMOKE_PROMPT || "Hello, identify yourself in one sentence.";

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

const res = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    messages: [{ role: "user", content: PROMPT }],
    personaId: PERSONA,
    model: MODEL,
  }),
});
httpFirstByteAt = performance.now();
if (!res.ok || !res.body) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
console.log(
  `HTTP_OK status=${res.status} content-type=${res.headers.get("content-type")}`
);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
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
}

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

process.exit(parseErrors === 0 && finalEvalCount > 0 ? 0 : 1);
