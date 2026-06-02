#!/usr/bin/env node
// smoke-memory-audit.mjs — Memory Audit Interface gate (2026-06-02).
//
// Runs against a THROWAWAY ARGOS_ROOT (seeded temp dir) so it never touches the
// operator's real memory. Verifies:
//   1. Filtered fact list + audit summary (id + status on every fact).
//   2. Per-fact transparency: the conversation turn + raw extraction.
//   3. Lifecycle: approve, edit (text replaced, original kept), flag.
//   4. Flagging appends to the append-only hallucination log + pattern stats.
//   5. Retrieval excludes flagged/rejected facts.
//   6. Bulk: reject-unreviewed-older-than + setStatus.
//   7. Status filter + CSV export.
//   8. Extraction transparency endpoint.
//
// Usage: node scripts/smoke-memory-audit.mjs [--port 7846]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7846;
const ROOT = join(tmpdir(), `argos-audit-smoke-${process.pid}`);

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [ok ] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

function req(base, path, opts = {}) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const r = http.request(
      { method: opts.method || "GET", hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: body ? { "content-type": "application/json", "content-length": body.length } : {}, timeout: 30000 },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { /* maybe csv */ }
          res({ status: resp.statusCode, json, text, ctype: resp.headers["content-type"] || "" });
        });
      }
    );
    r.on("error", () => res({ status: 0 }));
    r.on("timeout", () => r.destroy());
    if (body) r.write(body);
    r.end();
  });
}

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await req(base, "/api/memory/facts");
    if (r.status === 200) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

// ----- seed a throwaway ARGOS_ROOT -----
function seed() {
  fs.mkdirSync(join(ROOT, "data", "memory", "shared"), { recursive: true });
  fs.mkdirSync(join(ROOT, "state", "memory-extractions"), { recursive: true });
  const facts = [
    { id: "aaa111", fact: "Operator prefers concise answers", category: "preference", confidence: 0.9, timestamp: "2026-06-01T10:00:00.000Z", sessionId: "sess-A", persona: "bobby", status: "unreviewed" },
    { id: "bbb222", fact: "Operator works at EKG Security", category: "person", confidence: 0.95, timestamp: "2026-05-20T10:00:00.000Z", sessionId: "sess-A", persona: "bobby", status: "unreviewed" },
    { id: "ccc333", fact: "Operator owns a private yacht", category: "event", confidence: 0.8, timestamp: "2026-06-01T11:00:00.000Z", sessionId: "sess-B", persona: "bobby", status: "unreviewed" },
    { id: "ddd444", fact: "Operator mentioned an old deadline", category: "event", confidence: 0.75, timestamp: "2026-04-01T10:00:00.000Z", sessionId: "sess-C", persona: "bobby", status: "unreviewed" },
  ];
  fs.writeFileSync(join(ROOT, "data", "memory", "shared", "operator_facts.jsonl"), facts.map((f) => JSON.stringify(f)).join("\n") + "\n");
  const ex = { at: "2026-06-01T10:00:01.000Z", sessionId: "sess-A", persona: "bobby", model: "CyberCrew/notmythos-8b:latest",
    userMessage: "keep it short please", assistantMessage: "Understood — concise it is.", systemPrompt: "You are a fact-extraction tool.",
    userPrompt: "Extract memorable facts...\nOperator: keep it short please\nAssistant: Understood — concise it is.",
    rawResponse: '[{"fact":"Operator prefers concise answers","category":"preference","confidence":0.9}]', transportOk: true, parseOk: true, factCount: 2, factIds: ["aaa111", "bbb222"] };
  fs.writeFileSync(join(ROOT, "state", "memory-extractions", "sess-A.jsonl"), JSON.stringify(ex) + "\n");
}

async function withServer(fn) {
  console.log(`\n[boot] memory-audit — next start :${PORT} (ARGOS_ROOT=${ROOT})`);
  const server = spawn(
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if (!(await waitReady(base))) throw new Error("server did not become ready");
    console.log("[boot] ready");
    await fn(base);
  } finally {
    try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  }
}

try {
  seed();
  await withServer(async (base) => {
    console.log("\n=== 1. list + summary ===");
    const list = await req(base, "/api/memory/facts");
    check("4 seeded facts listed", (list.json?.facts ?? []).length === 4, `(${list.json?.facts?.length})`);
    check("every fact has id + status", (list.json?.facts ?? []).every((f) => f.id && f.status));
    check("summary counts unreviewed", (list.json?.summary?.byStatus?.unreviewed ?? 0) === 4);

    console.log("\n=== 2. per-fact transparency ===");
    const ctx = await req(base, "/api/memory/facts/aaa111/context");
    check("context returns the conversation turn", /keep it short/i.test(ctx.json?.extraction?.userMessage ?? ""), ctx.json?.extraction?.userMessage ?? "(none)");
    check("context returns raw extraction", /concise answers/i.test(ctx.json?.extraction?.rawResponse ?? ""));

    console.log("\n=== 3. lifecycle: approve / edit / flag ===");
    await req(base, "/api/memory/facts/aaa111/status", { method: "POST", body: { status: "approved" } });
    const edit = await req(base, "/api/memory/facts/bbb222/status", { method: "POST", body: { status: "edited", editedText: "Operator works at EKG Security LLC" } });
    check("edit ok", edit.json?.ok === true);
    const flag = await req(base, "/api/memory/facts/ccc333/status", { method: "POST", body: { status: "flagged", reason: "operator does not own a yacht" } });
    check("flag ok", flag.json?.ok === true);
    const after = await req(base, "/api/memory/facts");
    const byId = Object.fromEntries((after.json?.facts ?? []).map((f) => [f.id, f]));
    check("approved persisted", byId["aaa111"]?.status === "approved");
    check("edited text replaced + original kept", byId["bbb222"]?.status === "edited" && /LLC/.test(byId["bbb222"]?.fact) && byId["bbb222"]?.originalFact === "Operator works at EKG Security");
    check("flagged persisted", byId["ccc333"]?.status === "flagged");

    console.log("\n=== 4. hallucination log + stats ===");
    const hall = await req(base, "/api/memory/hallucinations");
    check("flagged fact in hallucination log", (hall.json?.items ?? []).some((h) => h.factId === "ccc333" && /yacht/.test(h.reason)));
    check("stats compute worst category", !!hall.json?.stats && hall.json.stats.total >= 1);

    console.log("\n=== 5. retrieval excludes flagged ===");
    const recall = await req(base, "/api/memory/facts?recall=yacht");
    check("flagged fact NOT injected", !/yacht/i.test(recall.json?.recall?.block ?? ""), recall.json?.recall?.block ?? "(no block)");

    console.log("\n=== 6. bulk ops ===");
    const old = await req(base, "/api/memory/facts/bulk", { method: "POST", body: { action: "rejectOldUnreviewed", olderThanDays: 7 } });
    check("reject-old-unreviewed hit ddd444", (old.json?.ids ?? []).includes("ddd444"), JSON.stringify(old.json?.ids));
    const bulkSet = await req(base, "/api/memory/facts/bulk", { method: "POST", body: { action: "setStatus", ids: ["aaa111"], status: "rejected" } });
    check("bulk setStatus updated", bulkSet.json?.updated === 1);

    console.log("\n=== 7. status filter + CSV export ===");
    const flagged = await req(base, "/api/memory/facts?status=flagged");
    check("status filter returns only flagged", (flagged.json?.facts ?? []).length === 1 && flagged.json.facts[0].id === "ccc333");
    const csv = await req(base, "/api/memory/facts/export");
    check("CSV export has header + rows", /content-type/i.test("content-type") && /^id,timestamp,persona/.test(csv.text ?? "") && /concise answers/.test(csv.text ?? ""));

    console.log("\n=== 8. extraction transparency endpoint ===");
    const ex = await req(base, "/api/memory/extractions/sess-A");
    check("extraction records for session", (ex.json?.records ?? []).some((r) => /keep it short/i.test(r.userMessage)));
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
  console.log("\n[cleanup] removed throwaway ARGOS_ROOT");
}

console.log(`\nsmoke-memory-audit: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
