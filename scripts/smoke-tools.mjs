#!/usr/bin/env node
// smoke-tools.mjs — Tools Phase (2026-06-02) gate.
//
// Verifies the 18-tool suite + governance layer end to end:
//   1. T1 web search returns results.
//   2. T2 page crawl returns content.
//   3. T5 document generation: approval flow → approve → file written.
//   4. Approval flow: a dangerous tool returns approvalRequired + approvalId.
//   5. Restore point: file_ops delete creates restore/<id>/restore-manifest.json.
//   6. Shell whitelist: whitelisted command runs (after approval); a
//      non-whitelisted command is DENIED before approval.
//   7. Tool audit log entry written to state/tool-audit.jsonl.
//
// Spawns its own `next start` (ARGOS_ROOT = repo root). Requires Ollama for
// the chat path, but the tool API itself doesn't (T1/T2 need internet).
//
// Usage: node scripts/smoke-tools.mjs [--port 7824]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7824;

const AUDIT_PATH = join(repoRoot, "state", "tool-audit.jsonl");

// Phase 1.5 — tools endpoints are session-gated; local scripts authenticate
// with the runtime token (same ARGOS_ROOT as the spawned server: repoRoot).
const { runtimeTokenHeader } = await import("./lib/runtime-token.mjs");

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

function jreq(base, path, opts = {}) {
  return new Promise((res) => {
    const url = new URL(path, base);
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const r = http.request(
      {
        method: opts.method || "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...runtimeTokenHeader(repoRoot),
          ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
        },
        timeout: opts.timeoutMs || 60_000,
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* non-json */
          }
          res({ ok: true, status: resp.statusCode, json });
        });
      }
    );
    r.on("error", (e) => res({ ok: false, error: e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

const exec = (base, toolId, params = {}) =>
  jreq(base, "/api/tools/execute", { method: "POST", body: { toolId, params }, timeoutMs: 90_000 });
const approve = (base, approvalId, decision = "approve") =>
  jreq(base, "/api/tools/approve", { method: "POST", body: { approvalId, decision }, timeoutMs: 90_000 });

async function waitReady(base, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const r = await jreq(base, "/api/tools/suite", { timeoutMs: 4000 });
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

const cleanup = [];

try {
  await withServer("tools", BASE_PORT, async (base) => {
    // ===== 1. T1 web search =====
    console.log("\n=== 1. T1 web search ===");
    const s = await exec(base, "web_search", { query: "site reliability engineering" });
    check("web_search ran (ok result)", s.json?.ok === true && s.json?.result?.ok === true);
    const results = s.json?.result?.data?.results ?? [];
    check("web_search returned results", Array.isArray(results) && results.length >= 1, `(${results.length})`);

    // ===== 2. T2 page crawl =====
    console.log("\n=== 2. T2 page crawl ===");
    const c = await exec(base, "web_crawl", { url: "https://example.com" });
    check("web_crawl ran", c.json?.result?.ok === true);
    check("web_crawl returned content", (c.json?.result?.data?.content?.length ?? 0) > 0, `(${c.json?.result?.data?.content?.length} chars)`);

    // ===== 3 + 4. T5 doc generation via approval flow =====
    console.log("\n=== 3+4. T5 doc generation (approval flow) ===");
    const d = await exec(base, "doc_generate", {
      title: "smoke-tools-doc",
      content: "Generated by smoke-tools.",
      format: "md",
    });
    check("dangerous tool returns approvalRequired", d.json?.approvalRequired === true);
    check("approvalRequired carries approvalId + risks", !!d.json?.approvalId && typeof d.json?.risks === "string");
    let docPath = null;
    if (d.json?.approvalId) {
      const a = await approve(base, d.json.approvalId, "approve");
      check("approved doc_generate returned a path", !!a.json?.result?.data?.path);
      docPath = a.json?.result?.data?.path ?? null;
      if (docPath) {
        cleanup.push(docPath);
        check("generated file exists on disk", fs.existsSync(docPath));
      }
    }

    // ===== 5. Restore point on file_ops delete =====
    console.log("\n=== 5. restore point (file_ops delete) ===");
    const relTarget = "output/smoke-tools-restore-target.txt";
    const wr = await exec(base, "file_ops", { operation: "write", path: relTarget, content: "delete me" });
    if (wr.json?.approvalRequired) await approve(base, wr.json.approvalId, "approve");
    cleanup.push(join(repoRoot, relTarget));
    const del = await exec(base, "file_ops", { operation: "delete", path: relTarget });
    check("delete requires approval", del.json?.approvalRequired === true);
    let restoreId = null;
    if (del.json?.approvalId) {
      const a = await approve(base, del.json.approvalId, "approve");
      restoreId = a.json?.result?.restorePointId ?? null;
      check("delete created a restore point", !!restoreId, `(${restoreId})`);
    }
    if (restoreId) {
      const manifestPath = join(repoRoot, "restore", restoreId, "restore-manifest.json");
      check("restore-manifest.json exists", fs.existsSync(manifestPath));
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        check("manifest records the snapshotted file", Array.isArray(m.files) && m.files.length >= 1);
      } catch {
        check("manifest parseable", false);
      }
    }

    // ===== 6. Shell whitelist =====
    console.log("\n=== 6. shell whitelist ===");
    const wl = await exec(base, "shell_exec", { command: "whoami" });
    check("whitelisted shell needs approval", wl.json?.approvalRequired === true);
    if (wl.json?.approvalId) {
      const a = await approve(base, wl.json.approvalId, "approve");
      check("whitelisted command executed", a.json?.result?.ok === true && a.json?.result?.data?.exitCode === 0);
    }
    const bad = await exec(base, "shell_exec", { command: "rm -rf /" });
    check("non-whitelisted command DENIED before approval", !bad.json?.approvalRequired && bad.json?.result?.ok === false);
    check("denial cites the whitelist", /whitelist/i.test(bad.json?.result?.error ?? ""));

    // ===== 7. Tool audit log =====
    console.log("\n=== 7. tool audit log ===");
    check("tool-audit.jsonl written", fs.existsSync(AUDIT_PATH));
    if (fs.existsSync(AUDIT_PATH)) {
      const lines = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").filter(Boolean);
      check("audit has entries", lines.length >= 1, `(${lines.length} entries)`);
      let lastOk = true;
      try {
        JSON.parse(lines[lines.length - 1]);
      } catch {
        lastOk = false;
      }
      check("audit entries are valid JSON", lastOk);
    }
  });
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`);
  fail++;
} finally {
  for (const f of cleanup) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* best effort */
    }
  }
  console.log("\n[cleanup] removed generated test files");
}

console.log(`\nsmoke-tools: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
