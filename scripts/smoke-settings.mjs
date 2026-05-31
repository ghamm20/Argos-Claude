#!/usr/bin/env node
// H5 smoke: hardware detection, settings persistence, model validation.
//
// Wire transport: node:http (not fetch). Global fetch/undici keepAlive trips
// a libuv assertion (UV_HANDLE_CLOSING) on process teardown on Windows node
// 24 — avoidable by sticking to http.request + agent.destroy() at end of
// smoke. Same wire protocol, no surprises.

import http from "node:http";

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const agent = new http.Agent({ keepAlive: false });

// fetch-shaped GET/POST over node:http so the call sites below read like the
// original. Returns a Response-like object with status/ok/json()/text().
function req(targetUrl, { method = "GET", headers = {}, body = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const r = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: { get: (h) => res.headers[h.toLowerCase()] ?? null },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    if (body) r.write(body);
    r.end();
  });
}

function assert(label, cond, detail = "") {
  const tag = cond ? "✓" : "✗";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log("HARDWARE DETECTION");
  const hwRes = await req(`${BASE}/api/hardware`);
  const hw = await hwRes.json();
  console.log("  profile:", JSON.stringify(hw, null, 2).slice(0, 600));
  assert("hardware GET returns 200", hwRes.status === 200);
  assert("profile has reason string", typeof hw.reason === "string" && hw.reason.length > 0);
  assert("profile has recommendedModel", typeof hw.recommendedModel === "string");
  assert(
    "mode is one of gpu/metal/cpu",
    ["gpu", "metal", "cpu"].includes(hw.mode)
  );
  assert("cpuCores > 0", typeof hw.cpuCores === "number" && hw.cpuCores > 0);
  assert("totalRamGB > 0", typeof hw.totalRamGB === "number" && hw.totalRamGB > 0);

  console.log("\nABOUT (inline server-props since H7; no /api/about route)");
  // /api/about was removed in H7.0b — runtime info now flows via
  // lib/runtime-info.ts -> server pages -> HUD/AboutSection as props.
  // We verify the pipeline end-to-end by GETting the server-rendered
  // /settings page and asserting it embeds the expected version/argosRoot
  // markers from package.json.
  const pkgRes = await req(`${BASE}/package.json`).catch(() => null);
  // Read package.json from disk (this script ships with the source repo)
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..");
  const expectedPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const expectedVersion = expectedPkg.version;
  const aboutPageRes = await req(`${BASE}/settings`);
  const aboutHtml = await aboutPageRes.text();
  assert("/settings server-renders with 200", aboutPageRes.status === 200);
  assert(
    `/settings HTML embeds package version ${expectedVersion}`,
    aboutHtml.includes(expectedVersion)
  );
  // Suppress unused-warn on the pkgRes attempt (some setups serve static
  // assets from public/; we don't rely on it).
  void pkgRes;

  console.log("\nSETTINGS PERSISTENCE");
  const initialRes = await req(`${BASE}/api/settings`);
  const initial = await initialRes.json();
  console.log("  initial:", JSON.stringify(initial));
  assert("settings GET 200", initialRes.status === 200);
  assert("has defaultPersona", typeof initial.defaultPersona === "string");

  const postRes = await req(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultPersona: "juniper" }),
  });
  const posted = await postRes.json();
  console.log("  after POST:", JSON.stringify(posted));
  assert("POST 200", postRes.status === 200);
  assert(
    "defaultPersona persisted to juniper",
    posted.defaultPersona === "juniper"
  );
  assert("updatedAt advanced", posted.updatedAt > initial.updatedAt);

  const rereadRes = await req(`${BASE}/api/settings`);
  const reread = await rereadRes.json();
  assert(
    "re-read preserves change",
    reread.defaultPersona === "juniper"
  );

  // Reject invalid persona
  const badPersonaRes = await req(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultPersona: "ghost" }),
  });
  assert("invalid persona rejected with 400", badPersonaRes.status === 400);

  // Reject invalid model
  const badModelRes = await req(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultModel: "fake-model" }),
  });
  assert("invalid model rejected with 400", badModelRes.status === 400);

  // Restore to bartimaeus so subsequent eyes-on starts clean
  await req(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultPersona: "bartimaeus" }),
  });

  console.log("\nCHAT MODEL VALIDATION");
  const badChatRes = await req(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      personaId: "bartimaeus",
      model: "not-a-real-model",
    }),
  });
  const badChat = await badChatRes.json();
  assert(
    "chat with invalid model rejected with 400",
    badChatRes.status === 400
  );
  assert(
    "rejection body includes availableModels list",
    Array.isArray(badChat.availableModels) &&
      badChat.availableModels.length >= 2
  );
}

main()
  .then(() => {
    agent.destroy();
  })
  .catch((e) => {
    console.error("SMOKE_ERROR:", e);
    agent.destroy();
    process.exit(1);
  });
