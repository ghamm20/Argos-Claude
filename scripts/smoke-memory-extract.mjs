#!/usr/bin/env node
// smoke-memory-extract.mjs — Memory Phase (2026-06-02) gate.
//
// Verifies semantic cross-session memory end to end:
//   1. Fact extraction from a sample exchange (Bobby → JSON facts).
//   2. Storage to operator_facts.jsonl (count + recent reflect the write).
//   3. Retrieval returns relevant facts for a matching query.
//   4. Injection format correct ("## What I recall", ≤300 chars).
//   5. Memory event in the chat NDJSON stream ({type:"memory", factsFound,
//      injected}).
//   6. Memory page status shape (/api/memory/facts).
//
// Honest + clean: snapshots operator_facts.jsonl AND memory/MEMORY.md before
// the run and restores them afterward, so the dev tree is never polluted.
//
// Requires a live Ollama with Bobby (CyberCrew/notmythos-8b:latest) pulled.
// Spawns its own `next start`, so the repo must be built first.
//
// Usage: node scripts/smoke-memory-extract.mjs [--port 7823]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7823;

const FACTS_PATH = join(repoRoot, "data", "memory", "shared", "operator_facts.jsonl");
const MD_PATH = join(repoRoot, "memory", "MEMORY.md");

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

function snapshot(p) {
  try {
    return { existed: true, content: fs.readFileSync(p, "utf8") };
  } catch {
    return { existed: false, content: null };
  }
}
function restore(p, snap) {
  try {
    if (snap.existed) fs.writeFileSync(p, snap.content, "utf8");
    else fs.rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

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
        timeout: opts.timeoutMs || 60_000,
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
          res({ ok: true, status: resp.statusCode, headers: resp.headers, json });
        });
      }
    );
    r.on("error", (e) => res({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// POST /api/chat and collect leading NDJSON frames until the memory frame is
// seen (or a few model tokens arrive), then abort. We only need the leading
// {type:"memory"} frame, not the full generation.
function chatLeadingFrames(base, payload, timeoutMs = 120_000) {
  return new Promise((res) => {
    const url = new URL("/api/chat", base);
    const body = Buffer.from(JSON.stringify(payload));
    const frames = [];
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
        let raw = "";
        let tokenLines = 0;
        resp.on("data", (c) => {
          raw += c.toString("utf8");
          let nl = raw.indexOf("\n");
          while (nl !== -1) {
            const line = raw.slice(0, nl).trim();
            raw = raw.slice(nl + 1);
            if (line) {
              try {
                const o = JSON.parse(line);
                frames.push(o);
                if (o.message?.content) tokenLines++;
              } catch {
                /* skip */
              }
            }
            nl = raw.indexOf("\n");
          }
          // Got the memory frame (or a few tokens) — we're done.
          if (frames.some((f) => f.type === "memory") && tokenLines >= 1) {
            resp.destroy();
            res({ ok: true, status: resp.statusCode, frames });
          }
        });
        resp.on("end", () => res({ ok: true, status: resp.statusCode, frames }));
        resp.on("close", () => res({ ok: true, status: resp.statusCode, frames }));
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
    const r = await jreq(base, "/api/memory/facts", { timeoutMs: 4000 });
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

const SAMPLE_USER =
  "My business partner Marcus runs the Jordan office, and I'm worried the Halal Jordan launch timeline is slipping.";
const SAMPLE_ASSISTANT =
  "Understood. Marcus is handling Jordan operations, and the Halal Jordan launch timeline is a concern to track.";

const snapFacts = snapshot(FACTS_PATH);
const snapMd = snapshot(MD_PATH);

try {
  await withServer("memory", BASE_PORT, async (base) => {
    // Start from a clean slate (restored from snapshot in finally).
    await jreq(base, "/api/memory/facts", { method: "DELETE" });

    // ===== 1. extraction =====
    console.log("\n=== 1. fact extraction (Bobby) ===");
    const t0 = Date.now();
    const ex = await jreq(base, "/api/memory/facts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userMessage: SAMPLE_USER,
        assistantMessage: SAMPLE_ASSISTANT,
        persona: "bartimaeus",
      }),
      timeoutMs: 90_000,
    });
    console.log(`  [latency] extract+store: ${Date.now() - t0} ms`);
    const facts = ex.json?.facts ?? [];
    check("extract responded 200", ex.ok && ex.status === 200, `(${ex.status ?? ex.error})`);
    check("extracted ≥1 fact", facts.length >= 1, `(${facts.length} facts)`);
    const shapeOk =
      facts.length > 0 &&
      facts.every(
        (f) =>
          typeof f.fact === "string" &&
          ["person", "project", "preference", "concern", "event"].includes(f.category) &&
          typeof f.confidence === "number" &&
          f.confidence >= 0.7
      );
    check("facts have valid shape (category + confidence≥0.7)", shapeOk);
    if (facts.length) console.log(`  [sample] ${facts.map((f) => `[${f.category}] ${f.fact}`).join(" | ")}`);

    // ===== 2. storage =====
    console.log("\n=== 2. storage to operator_facts.jsonl ===");
    const st = await jreq(base, "/api/memory/facts");
    check("count reflects stored facts", (st.json?.count ?? 0) >= facts.length, `(count=${st.json?.count})`);
    const storedMarcus = (st.json?.recent ?? []).some((f) => /marcus/i.test(f.fact));
    check("recent facts include the Marcus fact", storedMarcus);
    check("file written on disk", fs.existsSync(FACTS_PATH));

    // ===== 3. retrieval =====
    console.log("\n=== 3. retrieval (keyword match) ===");
    const rec = await jreq(
      base,
      `/api/memory/facts?recall=${encodeURIComponent("Tell me about Marcus and the Jordan office")}`
    );
    const recall = rec.json?.recall;
    check("retrieval found ≥1 relevant fact", (recall?.factsFound ?? 0) >= 1, `(factsFound=${recall?.factsFound})`);
    check("retrieval marked injected", recall?.injected === true);

    // ===== 4. injection format =====
    console.log("\n=== 4. injection format ===");
    check(
      "block starts with '## What I recall'",
      typeof recall?.block === "string" && recall.block.startsWith("## What I recall")
    );
    check("block ≤300 chars", (recall?.block?.length ?? 999) <= 300, `(${recall?.block?.length} chars)`);
    check("block contains a recalled fact", /marcus|jordan/i.test(recall?.block ?? ""));

    // ===== 5. memory event in chat stream =====
    console.log("\n=== 5. memory event in /api/chat stream ===");
    const ch = await chatLeadingFrames(base, {
      messages: [{ role: "user", content: "Remind me what Marcus handles in Jordan." }],
      personaId: "bobby",
      model: "CyberCrew/notmythos-8b:latest",
    });
    const memFrame = ch.frames?.find((f) => f.type === "memory");
    check("chat stream emitted a memory frame", !!memFrame);
    check(
      "memory frame has factsFound + injected",
      memFrame && typeof memFrame.factsFound === "number" && typeof memFrame.injected === "boolean",
      memFrame ? `(factsFound=${memFrame.factsFound}, injected=${memFrame.injected})` : ""
    );
    check("memory frame recalled the Marcus fact", memFrame?.factsFound >= 1 && memFrame?.injected === true);

    // ===== 6. page status shape =====
    console.log("\n=== 6. /api/memory/facts status shape ===");
    const status = await jreq(base, "/api/memory/facts");
    check(
      "status has count/recent/memoryMdUpdated/memoryMdExists",
      status.json &&
        typeof status.json.count === "number" &&
        Array.isArray(status.json.recent) &&
        "memoryMdUpdated" in status.json &&
        "memoryMdExists" in status.json
    );
    check("MEMORY.md recorded as updated", status.json?.memoryMdExists === true && !!status.json?.memoryMdUpdated);
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  restore(FACTS_PATH, snapFacts);
  restore(MD_PATH, snapMd);
  console.log("\n[cleanup] restored operator_facts.jsonl + MEMORY.md to pre-test state");
}

console.log(`\nsmoke-memory-extract: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
