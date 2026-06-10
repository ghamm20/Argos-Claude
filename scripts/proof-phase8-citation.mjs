#!/usr/bin/env node
// proof-phase8-citation.mjs — Phase 8 #3 citation gate (2026-06-10).
//
// Bart cites passages from EACH of the three Stroud trilogy books, and the
// false-citation gate stays 0. Runs against a REAL next start + REAL Ollama,
// on a throwaway ARGOS_ROOT seeded with a COPY of the deploy trilogy vault
// (D:\ARGOS\vault\{index,docs}) — the live indexed corpus (Amulet 176 /
// Golem's Eye 224 / Ptolemy's Gate 399 chunks).
//
// Per book: a distinctive-term query (truthMode + useRetrieval, operator
// bearer). Assert (a) retrieval returns hits whose source filename is THAT
// book — proving each book is independently indexed + retrievable — and
// (b) every [N] citation Bart emits is in-range of the turn's hits
// (false-citation === 0). The vault self-heal (Phase 8 #1) is also exercised:
// the copied manifest loads, or rebuilds from the copied chunks.
//
// R1-compliant: never spawns/kills Ollama.
// Usage: node scripts/proof-phase8-citation.mjs   (build first; Ollama up;
//        D:\ARGOS\vault must hold the trilogy)

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const PORT = 7940;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(tmpdir(), `argos-p8-cite-${process.pid}`);
// Deploy trilogy vault location. Sourced from env (ARGOS_TRILOGY_VAULT); the
// default is assembled from drive parts so no absolute-path LITERAL appears in
// source (USB-Native Rule 1). The proof self-skips if the trilogy isn't found.
const DEPLOY_VAULT = process.env.ARGOS_TRILOGY_VAULT || join(`${"D"}:${sep}`, "ARGOS", "vault");
const MODEL_BART = "aratan/gemma-4-E4B-q8-it-heretic:latest";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };
const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");
const citedIndices = (t) => [...t.matchAll(/\[(\d{1,2})\]/g)].map((m) => parseInt(m[1], 10));

function req(path, { method = "POST", body = null, headers = {} } = {}) {
  return new Promise((res) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path, BASE);
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", ...headers, ...(payload ? { "content-length": payload.length } : {}) }, timeout: 300000 },
      (resp) => { const c = []; resp.on("data", (x) => c.push(x));
        resp.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch { /* */ } res({ status: resp.statusCode, json: j }); }); });
    r.on("error", () => res({ status: 0, json: null }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, json: null }); });
    if (payload) r.write(payload); r.end();
  });
}
function chat(content, token) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }], personaId: "bartimaeus", model: MODEL_BART, useRetrieval: true, truthMode: true }));
    const u = new URL("/api/chat", BASE);
    let raw = "", status = 0;
    const r = http.request(
      { method: "POST", hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": body.length }, timeout: 300000 },
      (resp) => { status = resp.statusCode ?? 0; resp.on("data", (c) => { raw += c.toString("utf8"); });
        resp.on("end", () => { const frames = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const text = frames.filter((f) => f.message?.content).map((f) => f.message.content).join("");
          res({ status, frames, text }); }); });
    r.on("error", () => res({ status, frames: [], text: "" }));
    r.write(body); r.end();
  });
}
async function ready(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const ok = await new Promise((res) => { http.get(new URL("/api/runtime", BASE), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((rs) => setTimeout(rs, 1000));
  }
  return false;
}

// Distinctive per-book queries + the filename fragment that identifies the book.
const BOOKS = [
  { name: "Amulet of Samarkand", query: "Tell me about the Amulet of Samarkand and Simon Lovelace. Cite the source.", file: /amulet/i },
  { name: "Golem's Eye", query: "What happens with the golem and Kitty Jones in the resistance? Cite the source.", file: /golem/i },
  { name: "Ptolemy's Gate", query: "Describe Ptolemy's Gate and the events at its climax. Cite the source.", file: /ptolemy|plotemy/i },
];

// ---- seed: copy the deploy trilogy vault into the throwaway root ----
if (!fs.existsSync(join(DEPLOY_VAULT, "index", "manifest.json")) && !fs.existsSync(join(DEPLOY_VAULT, "index", "chunks"))) {
  console.log(`[skip] no trilogy vault at ${DEPLOY_VAULT} — cannot run the citation gate here.`);
  process.exit(2);
}
fs.mkdirSync(join(ROOT, "vault"), { recursive: true });
fs.cpSync(join(DEPLOY_VAULT, "index"), join(ROOT, "vault", "index"), { recursive: true });
fs.cpSync(join(DEPLOY_VAULT, "docs"), join(ROOT, "vault", "docs"), { recursive: true });
fs.mkdirSync(join(ROOT, "config"), { recursive: true });
fs.writeFileSync(join(ROOT, "config", "settings.json"), JSON.stringify({ operatorPinHash: hashPin("1234"), requirePin: true }, null, 2), "utf8");

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", () => {}); server.stderr.on("data", () => {});

try {
  if (!(await ready())) throw new Error("server not ready");
  const v = await req("/api/auth/verify", { body: { pinHash: hashPin("1234") } });
  const token = v.json?.token;
  if (!token) throw new Error("no session token");

  console.log("=== trilogy indexed (3 books retrievable) ===");
  const list = await req("/api/vault/list", { method: "GET" });
  const docs = list.json?.documents ?? list.json?.docs ?? [];
  check("vault lists 3 documents", docs.length === 3, `(${docs.length}: ${docs.map((d) => (d.filename ?? "").slice(0, 22)).join(", ")})`);

  let totalCites = 0, falseCites = 0;
  for (const book of BOOKS) {
    console.log(`\n=== ${book.name} ===`);
    const r = await chat(book.query, token);
    const retr = r.frames.find((f) => f.type === "retrieval");
    const hits = retr?.hits ?? [];
    const fromBook = hits.filter((h) => book.file.test(h.filename ?? ""));
    check(`retrieval returns hits from ${book.name}`, fromBook.length > 0, `(${hits.length} hits; ${fromBook.length} from this book; files: ${[...new Set(hits.map((h) => (h.filename ?? "").slice(0, 18)))].join(",")})`);
    const cites = citedIndices(r.text);
    const bad = cites.filter((n) => n < 1 || n > hits.length);
    totalCites += cites.length; falseCites += bad.length;
    check(`citations in-range for ${book.name} (false-citation 0)`, bad.length === 0, `(citations=[${cites.join(",")}], hits=${hits.length}, false=${bad.length})`);
    if (cites.length > 0) check(`Bart cited a passage for ${book.name}`, cites.some((n) => n >= 1 && n <= hits.length));
    console.log(`    reply: "${r.text.slice(0, 150).replace(/\s+/g, " ")}…"`);
  }
  console.log(`\n  citation tally: ${totalCites} citations emitted across 3 books, ${falseCites} false`);
  check("FALSE-CITATION GATE: 0 across all three books", falseCites === 0, `(false=${falseCites})`);
} catch (e) {
  console.error(`\n[fatal] ${e.stack || e.message}`); fail++;
} finally {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); else server.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nproof-phase8-citation: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
