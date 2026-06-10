#!/usr/bin/env node
// proof-phase8-vault-integrity.mjs — Phase 8 #1 (2026-06-10).
//
// ROOT CAUSE (lib/vault/store.ts): the manifest write was NON-ATOMIC (plain
// fsp.writeFile truncate-then-write), so a USB yank / crash mid-write left a
// 0-byte or partial manifest. readManifest then either threw (corrupt) or, on
// a MISSING file, silently returned {documents:[]} — the vault reported empty
// while every chunk + original sat orphaned on disk. "A vault that silently
// loses files."
//
// FIX: (1) atomic manifest write (temp + fsync + rename); (2) self-heal — when
// the manifest is missing OR corrupt but chunk files exist, rebuild it from
// the chunks (the source of truth), persist atomically, audit
// vault.manifest_recovered (never silent).
//
// PROOF (against a real next start + real Ollama, throwaway root):
//   A. ingest a doc → manifest + chunks on disk; retrieval finds it.
//   B. SILENT-LOSS sim: DELETE manifest.json (chunks remain) → next read
//      self-heals; retrieval STILL finds the doc; vault.manifest_recovered
//      audited; manifest is valid JSON again.
//   C. CORRUPT sim: truncate manifest.json to a partial byte → next read
//      self-heals the same way (not a throw, not empty).
//   D. survives a RELAUNCH: kill the server, restart on the SAME root with the
//      manifest still deleted → first read on boot recovers; retrieval works.
//   E. atomic-write proof: after recovery the manifest is parseable + complete
//      (the temp+rename leaves no partial file).
//
// R1-compliant: never spawns/kills Ollama.
// Usage: node scripts/proof-phase8-vault-integrity.mjs   (build first; Ollama up)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7938;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-p8-vault-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MANIFEST = join(ROOT, "vault", "index", "manifest.json");
const CHUNKS_DIR = join(ROOT, "vault", "index", "chunks");
const audit = (kind) => { try { return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };

function req(path, { method = "GET", body = null, headers = {}, raw = null } = {}) {
  return new Promise((res) => {
    const payload = raw ?? (body ? Buffer.from(JSON.stringify(body)) : null);
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { ...(raw ? {} : body ? { "content-type": "application/json" } : {}), ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ } res({ status: resp.statusCode, json: j, text }); }); });
    r.on("error", (e) => res({ status: 0, json: null, text: String(e) }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null, text: "timeout" }); });
    if (payload) r.write(payload); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}
function startServer() {
  const s = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  s.stdout.on("data", () => {}); s.stderr.on("data", () => {});
  return s;
}
const killServer = (s) => { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(s.pid)], { stdio: "ignore" }); } catch { /* */ } };

const DOC = [
  "# Vault Integrity Test Doc",
  "The distinctive marker phrase is ZANZIBAR_PELICAN_42 for retrieval.",
  "ARGOS uses in-memory cosine over nomic-embed-text. Zero host persistence is rule one.",
].join("\n");

async function ingest() {
  const boundary = "----argosP8Boundary";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="integrity-test.md"\r\nContent-Type: text/markdown\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return req("/api/vault/upload", { method: "POST", raw: Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(DOC, "utf8"), Buffer.from(tail, "utf8")]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
}
async function search(q) { return req("/api/vault/search", { method: "POST", body: { query: q, topK: 5 } }); }
const manifestDocCount = () => { try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")).documents.length; } catch { return -1; } };

fs.mkdirSync(ROOT, { recursive: true });
let server = startServer();
try {
  if (!(await ready())) throw new Error("server not ready");

  console.log("=== A. ingest → manifest + chunks on disk, retrieval finds it ===");
  const up = await ingest();
  check("ingest 200", up.status === 200, `(status=${up.status})`);
  await sleep(500);
  check("manifest has 1 doc", manifestDocCount() === 1, `(count=${manifestDocCount()})`);
  const chunkFiles = fs.existsSync(CHUNKS_DIR) ? fs.readdirSync(CHUNKS_DIR).filter((n) => n.endsWith(".json")) : [];
  check("chunk file on disk", chunkFiles.length === 1, `(${chunkFiles.length})`);
  const s1 = await search("ZANZIBAR_PELICAN_42");
  check("retrieval finds the marker pre-loss", (s1.json?.hits?.length ?? 0) > 0, `(hits=${s1.json?.hits?.length})`);

  console.log("\n=== B. SILENT-LOSS sim: delete manifest.json (chunks remain) → self-heal ===");
  fs.rmSync(MANIFEST, { force: true });
  check("manifest deleted (chunks intact)", !fs.existsSync(MANIFEST) && fs.readdirSync(CHUNKS_DIR).length === 1);
  const s2 = await search("ZANZIBAR_PELICAN_42");
  check("retrieval STILL finds the marker (recovered, not lost)", (s2.json?.hits?.length ?? 0) > 0, `(hits=${s2.json?.hits?.length})`);
  await sleep(300);
  check("manifest rebuilt on disk (1 doc)", manifestDocCount() === 1, `(count=${manifestDocCount()})`);
  check("vault.manifest_recovered audited (not silent)", audit("vault.manifest_recovered").length >= 1);
  const rec = audit("vault.manifest_recovered").pop();
  if (rec) console.log(`  recovery audit verbatim: ${JSON.stringify(rec.payload)}`);

  console.log("\n=== C. CORRUPT sim: truncate manifest to a partial byte → self-heal ===");
  fs.writeFileSync(MANIFEST, '{"version":1,"docume', "utf8"); // truncated mid-write
  const s3 = await search("ZANZIBAR_PELICAN_42");
  check("retrieval finds the marker despite corrupt manifest", (s3.json?.hits?.length ?? 0) > 0, `(hits=${s3.json?.hits?.length})`);
  await sleep(300);
  check("corrupt manifest healed to valid JSON (1 doc)", manifestDocCount() === 1, `(count=${manifestDocCount()})`);

  console.log("\n=== D. survives a RELAUNCH with manifest deleted ===");
  fs.rmSync(MANIFEST, { force: true });
  killServer(server);
  await sleep(2000);
  server = startServer();
  if (!(await ready())) throw new Error("server did not come back");
  const s4 = await search("ZANZIBAR_PELICAN_42");
  check("retrieval works after relaunch (manifest recovered on boot read)", (s4.json?.hits?.length ?? 0) > 0, `(hits=${s4.json?.hits?.length})`);
  check("manifest valid post-relaunch", manifestDocCount() === 1, `(count=${manifestDocCount()})`);

  console.log("\n=== E. atomic-write proof: recovered manifest is complete + parseable ===");
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  check("manifest parses + has the doc with chunkCount", m.documents?.[0]?.chunkCount > 0 && typeof m.documents[0].id === "string", JSON.stringify(m.documents?.[0]));
  // No leftover temp files (rename consumed them).
  const tmps = fs.readdirSync(join(ROOT, "vault", "index")).filter((n) => n.includes(".tmp"));
  check("no orphaned manifest .tmp files (atomic rename)", tmps.length === 0, `(${tmps.join(", ")})`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  killServer(server);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase8-vault-integrity: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
