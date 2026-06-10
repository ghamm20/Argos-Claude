#!/usr/bin/env node
// proof-phase9-chunk-trust.mjs — Phase 9 rider (Phase 8 carryover, 2026-06-10).
//
// Self-heal TRUST BOUNDARY. The manifest rebuilds from on-disk chunks, so a
// planted chunk could become canon after a heal. Fix: anchor trust in the
// hash-chained audit log — each chunk's sha256 is recorded in vault.ingested
// at ingest, verified at heal; tampered or provenance-less chunks are
// quarantined (moved to vault/index/quarantine/) + audited, never indexed.
//
// PROOF (real next start + Ollama, throwaway root):
//   A. ingest a legit doc → its vault.ingested entry carries chunkSha256.
//   B. PLANT a chunk file with NO provenance, delete the manifest → heal
//      QUARANTINES the planted chunk (not indexed, retrieval can't reach it),
//      audits vault.chunk_quarantined; the legit doc is still recovered.
//   C. TAMPER the legit chunk (rewrite bytes), delete manifest → heal detects
//      the sha256 mismatch → quarantines it + audits; retrieval no longer
//      returns the tampered content.
//   D. grace: a provenance-less vault (chunks present, audit chain wiped) heals
//      by indexing all chunks + audits vault.heal_unverified (no wholesale
//      quarantine of a legitimate copy).
//
// R1-compliant: never spawns/kills Ollama.
// Usage: node scripts/proof-phase9-chunk-trust.mjs   (build first; Ollama up)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7942;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-p9-trust-${process.pid}`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MANIFEST = join(ROOT, "vault", "index", "manifest.json");
const CHUNKS_DIR = join(ROOT, "vault", "index", "chunks");
const QUAR_DIR = join(ROOT, "vault", "index", "quarantine");
const audit = (kind) => { try { return fs.readFileSync(join(ROOT, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };

function req(path, { method = "GET", body = null, headers = {}, raw = null } = {}) {
  return new Promise((res) => {
    const payload = raw ?? (body ? Buffer.from(JSON.stringify(body)) : null);
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { ...(raw ? {} : body ? { "content-type": "application/json" } : {}), ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 120000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ } res({ status: resp.statusCode, json: j }); }); });
    r.on("error", () => res({ status: 0, json: null }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null }); });
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
const ingest = (name, content) => {
  const boundary = "----argosP9Boundary";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n`;
  return req("/api/vault/upload", { method: "POST", raw: Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(content, "utf8"), Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
};
const search = (q) => req("/api/vault/search", { method: "POST", body: { query: q, topK: 5 } });
const chunkFiles = () => (fs.existsSync(CHUNKS_DIR) ? fs.readdirSync(CHUNKS_DIR).filter((n) => n.endsWith(".json")) : []);
const quarFiles = () => (fs.existsSync(QUAR_DIR) ? fs.readdirSync(QUAR_DIR).filter((n) => n.endsWith(".json")) : []);

fs.mkdirSync(ROOT, { recursive: true });
const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");

  console.log("=== A. ingest legit doc → vault.ingested carries chunkSha256 ===");
  const up = await ingest("legit.md", "The legitimate marker is ORYX_TAMARIND_legit for retrieval. Zero host persistence.");
  check("ingest 200", up.status === 200);
  await sleep(400);
  const ing = audit("vault.ingested");
  check("vault.ingested recorded with chunkSha256", ing.length === 1 && /^[a-f0-9]{64}$/.test(ing[0].payload?.chunkSha256 ?? ""), `(chunkSha256=${(ing[0]?.payload?.chunkSha256 ?? "").slice(0, 12)}…)`);
  const legitChunk = chunkFiles()[0];
  const s0 = await search("ORYX_TAMARIND_legit");
  check("retrieval finds the legit doc", (s0.json?.hits?.length ?? 0) > 0);

  console.log("\n=== B. PLANT a chunk with no provenance → quarantined on heal ===");
  // A planted chunk: valid ChunksFile shape, but no vault.ingested entry.
  const planted = { version: 1, chunks: [{ chunkId: "planted-0", text: "INJECTED canon: the planted fact is FORGED_PELICAN_evil.", embedding: Array(768).fill(0.05), metadata: { docId: "deadbeefdeadbeef", chunkIndex: 0, charStart: 0, charEnd: 40 } }] };
  fs.writeFileSync(join(CHUNKS_DIR, "deadbeefdeadbeef.json"), JSON.stringify(planted), "utf8");
  fs.rmSync(MANIFEST, { force: true }); // force a heal on next read
  const sB = await search("FORGED_PELICAN_evil");
  check("planted content NOT retrievable (quarantined, not indexed)", (sB.json?.hits?.length ?? 0) === 0, `(hits=${sB.json?.hits?.length})`);
  await sleep(300);
  check("planted chunk moved to quarantine/", quarFiles().includes("deadbeefdeadbeef.json"));
  check("vault.chunk_quarantined audited (planted)", audit("vault.chunk_quarantined").some((e) => e.payload?.docId === "deadbeefdeadbeef" && /planted|provenance/i.test(e.payload?.reason ?? "")));
  const sB2 = await search("ORYX_TAMARIND_legit");
  check("legit doc still recovered alongside the quarantine", (sB2.json?.hits?.length ?? 0) > 0);
  const q = audit("vault.chunk_quarantined").find((e) => e.payload?.docId === "deadbeefdeadbeef");
  if (q) console.log(`  quarantine audit verbatim: ${JSON.stringify(q.payload)}`);

  console.log("\n=== C. TAMPER the legit chunk → sha mismatch → quarantined ===");
  // Rewrite the legit chunk's bytes (different content → different sha256).
  const legitPath = join(CHUNKS_DIR, legitChunk);
  const tampered = JSON.parse(fs.readFileSync(legitPath, "utf8"));
  tampered.chunks[0].text = "TAMPERED: ORYX_TAMARIND_legit replaced with SABOTAGE_text.";
  fs.writeFileSync(legitPath, JSON.stringify(tampered), "utf8");
  fs.rmSync(MANIFEST, { force: true });
  const sC = await search("SABOTAGE_text");
  check("tampered content NOT retrievable (quarantined on hash mismatch)", (sC.json?.hits?.length ?? 0) === 0, `(hits=${sC.json?.hits?.length})`);
  await sleep(300);
  check("vault.chunk_quarantined audited (tamper / sha mismatch)", audit("vault.chunk_quarantined").some((e) => /mismatch|tampered/i.test(e.payload?.reason ?? "")));

  console.log("\n=== D. grace: provenance-less vault heals with heal_unverified ===");
  // Fresh root: chunks present, NO audit chain → legacy/operator-local trust.
  const ROOT2 = join(tmpdir(), `argos-p9-grace-${process.pid}`);
  fs.mkdirSync(join(ROOT2, "vault", "index", "chunks"), { recursive: true });
  fs.writeFileSync(join(ROOT2, "vault", "index", "chunks", "abc123.json"), JSON.stringify({ version: 1, chunks: [{ chunkId: "abc123-0", text: "copied vault chunk", embedding: Array(768).fill(0.1), metadata: { docId: "abc123", chunkIndex: 0, charStart: 0, charEnd: 18 } }] }), "utf8");
  // Boot a second server on this provenance-less root.
  const PORT2 = PORT + 1;
  const srv2 = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT2)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT2 }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  srv2.stdout.on("data", () => {}); srv2.stderr.on("data", () => {});
  const ready2 = await (async () => { for (let i = 0; i < 60; i++) { const ok = await new Promise((res) => { http.get(`http://127.0.0.1:${PORT2}/api/runtime`, (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); }); if (ok) return true; await sleep(1000); } return false; })();
  if (ready2) {
    await new Promise((res) => { const body = Buffer.from(JSON.stringify({ query: "copied", topK: 3 })); const r = http.request({ method: "POST", hostname: "127.0.0.1", port: PORT2, path: "/api/vault/search", headers: { "content-type": "application/json", "content-length": body.length } }, (resp) => { resp.resume(); resp.on("end", res); }); r.write(body); r.end(); });
    await sleep(300);
    const hu = (() => { try { return fs.readFileSync(join(ROOT2, "state", "audit", "chain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "vault.heal_unverified"); } catch { return []; } })();
    check("provenance-less heal indexed chunks + audited heal_unverified (no wholesale quarantine)", hu.length >= 1 && fs.existsSync(join(ROOT2, "vault", "index", "manifest.json")));
  } else {
    check("grace server booted", false);
  }
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(srv2.pid)]); else srv2.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch { /* */ }
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase9-chunk-trust: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
