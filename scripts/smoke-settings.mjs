#!/usr/bin/env node
// H5 smoke: hardware detection, settings persistence, model validation.

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";

function assert(label, cond, detail = "") {
  const tag = cond ? "✓" : "✗";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log("HARDWARE DETECTION");
  const hwRes = await fetch(`${BASE}/api/hardware`);
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

  console.log("\nABOUT");
  const aboutRes = await fetch(`${BASE}/api/about`);
  const about = await aboutRes.json();
  console.log("  about:", JSON.stringify(about));
  assert("about GET returns 200", aboutRes.status === 200);
  assert("has version", typeof about.version === "string");
  assert("has argosRoot", typeof about.argosRoot === "string");

  console.log("\nSETTINGS PERSISTENCE");
  const initialRes = await fetch(`${BASE}/api/settings`);
  const initial = await initialRes.json();
  console.log("  initial:", JSON.stringify(initial));
  assert("settings GET 200", initialRes.status === 200);
  assert("has defaultPersona", typeof initial.defaultPersona === "string");

  const postRes = await fetch(`${BASE}/api/settings`, {
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

  const rereadRes = await fetch(`${BASE}/api/settings`);
  const reread = await rereadRes.json();
  assert(
    "re-read preserves change",
    reread.defaultPersona === "juniper"
  );

  // Reject invalid persona
  const badPersonaRes = await fetch(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultPersona: "ghost" }),
  });
  assert("invalid persona rejected with 400", badPersonaRes.status === 400);

  // Reject invalid model
  const badModelRes = await fetch(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultModel: "fake-model" }),
  });
  assert("invalid model rejected with 400", badModelRes.status === 400);

  // Restore to bartimaeus so subsequent eyes-on starts clean
  await fetch(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultPersona: "bartimaeus" }),
  });

  console.log("\nCHAT MODEL VALIDATION");
  const badChatRes = await fetch(`${BASE}/api/chat`, {
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

main().catch((e) => {
  console.error("SMOKE_ERROR:", e);
  process.exit(1);
});
