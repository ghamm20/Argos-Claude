#!/usr/bin/env node
// smoke-input-validation.mjs
//
// Regression guard for Phase O input-validation hardening. Walks each
// /api route with malformed payloads and asserts the route rejects
// them with a sensible 4xx (not a 5xx, not a crash, not a silent
// accept).
//
// Requires a running dev server on SMOKE_BASE (default :3000).

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";

let passed = 0;
let failed = 0;
function pass(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failed++;
  console.log(`  ✗ ${label}  ${detail}`);
}

async function expect4xx(label, url, body, opts = {}) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...opts,
  };
  try {
    const r = await fetch(`${BASE}${url}`, init);
    if (r.status >= 400 && r.status < 500) {
      pass(`${label} → ${r.status}`);
    } else {
      fail(label, `expected 4xx, got ${r.status}`);
    }
  } catch (e) {
    fail(label, `fetch threw: ${e.message}`);
  }
}

// ---------- /api/chat ----------
console.log("\n[chat]");
await expect4xx("empty body", "/api/chat", "not json");
await expect4xx("no messages", "/api/chat", { personaId: "bartimaeus", model: "x" });
await expect4xx(
  "empty messages array",
  "/api/chat",
  { messages: [], personaId: "bartimaeus", model: "x" }
);
await expect4xx(
  "too many messages",
  "/api/chat",
  {
    messages: Array(250).fill({ role: "user", content: "hi" }),
    personaId: "bartimaeus",
    model: "llama3.1:8b-instruct-q4_K_M",
  }
);
await expect4xx(
  "invalid role",
  "/api/chat",
  {
    messages: [{ role: "robot", content: "hi" }],
    personaId: "bartimaeus",
    model: "llama3.1:8b-instruct-q4_K_M",
  }
);
await expect4xx(
  "non-string content",
  "/api/chat",
  {
    messages: [{ role: "user", content: 42 }],
    personaId: "bartimaeus",
    model: "llama3.1:8b-instruct-q4_K_M",
  }
);
await expect4xx(
  "oversized content (>100 KB)",
  "/api/chat",
  {
    messages: [{ role: "user", content: "x".repeat(200_001) }],
    personaId: "bartimaeus",
    model: "llama3.1:8b-instruct-q4_K_M",
  }
);
await expect4xx(
  "unknown persona",
  "/api/chat",
  {
    messages: [{ role: "user", content: "hi" }],
    personaId: "ghost",
    model: "llama3.1:8b-instruct-q4_K_M",
  }
);
await expect4xx(
  "unknown model",
  "/api/chat",
  {
    messages: [{ role: "user", content: "hi" }],
    personaId: "bartimaeus",
    model: "fake-model-xyz",
  }
);

// ---------- /api/settings ----------
console.log("\n[settings]");
await expect4xx("invalid JSON", "/api/settings", "{not json");
await expect4xx("no recognized fields", "/api/settings", { random: "value" });
await expect4xx("non-string persona", "/api/settings", { defaultPersona: 42 });
await expect4xx("unknown persona", "/api/settings", { defaultPersona: "ghost" });
await expect4xx("non-string model", "/api/settings", { defaultModel: 999 });
await expect4xx("unknown model", "/api/settings", { defaultModel: "fake-model" });

// ---------- /api/vault/search ----------
console.log("\n[vault/search]");
await expect4xx("invalid JSON", "/api/vault/search", "not json");
await expect4xx("no query", "/api/vault/search", {});
await expect4xx("empty query", "/api/vault/search", { query: "" });
await expect4xx("non-string query", "/api/vault/search", { query: 42 });
await expect4xx(
  "oversized query (>10K)",
  "/api/vault/search",
  { query: "x".repeat(20_001) }
);

// ---------- /api/vault/delete ----------
console.log("\n[vault/delete]");
await expect4xx("invalid JSON", "/api/vault/delete", "not json");
await expect4xx("no docId", "/api/vault/delete", {});
await expect4xx("empty docId", "/api/vault/delete", { docId: "" });
await expect4xx("non-string docId", "/api/vault/delete", { docId: 42 });
await expect4xx(
  "oversized docId (>128)",
  "/api/vault/delete",
  { docId: "x".repeat(200) }
);

// ---------- /api/vault/upload ----------
console.log("\n[vault/upload]");
await expect4xx(
  "non-multipart body",
  "/api/vault/upload",
  "not multipart",
  { headers: { "content-type": "application/json" } }
);
// (Multipart edge cases — missing 'file' field — would need a FormData
// constructor here; the JSON path catches the parse-error case already.)

// ---------- summary ----------
console.log("\n" + "=".repeat(64));
console.log(`smoke-input-validation: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
