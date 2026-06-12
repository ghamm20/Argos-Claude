#!/usr/bin/env node
// proof-chain-ruling.mjs — owner chain ruling (2026-06-12), demonstrated proof.
//
//   1. SYNTHETIC fork chain (the live race signature: two siblings sharing
//      index + prevHash):
//        a. unannotated         → verifier hard FAIL ("unannotated fork")
//        b. fork-annotated      → verifier PASS, GREEN_WITH_NOTED_FORKS
//        c. tampered branch     → verifier hard FAIL (content tamper) even
//                                 though the fork is annotated
//   2. LIVE MUTEX: spawn the real server on a throwaway ARGOS_ROOT and fire
//      24 CONCURRENT session-create POSTs (the exact writer class that forked
//      the live chain at 62/208/262). The chain must come out fork-free and
//      verify GREEN.
//
// Usage: node scripts/proof-chain-ruling.mjs [--port 7901] [--skip-live]

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 7901;
const SKIP_LIVE = process.argv.includes("--skip-live");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  [ok ] ${n}${d ? "  " + d : ""}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? "  " + d : ""}`); } };

function canonicalJson(value) {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}
const entryHash = (rest) => createHash("sha256").update(rest.prevHash).update(":").update(canonicalJson(rest)).digest("hex");
function mkEntry(index, kind, payload, prevHash, ts) {
  const rest = { version: 1, index, ts, id: randomUUID().replace(/-/g, ""), kind, payload, prevHash };
  return { ...rest, hash: entryHash(rest) };
}
function runVerify(chainFile) {
  const r = spawnSync(process.execPath, [join(__dir, "verify-audit-chain.mjs"), "--chain", chainFile], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

// ---- 1. synthetic fork scenarios ----
console.log("=== 1. Synthetic fork chain ===");
const dir = fs.mkdtempSync(join(tmpdir(), "argos-chain-ruling-"));
const t0 = 1700000000000;
const e0 = mkEntry(0, "session.created", { a: 1 }, "", t0);
const e1 = mkEntry(1, "settings.changed", { changed: ["x"] }, e0.hash, t0 + 1000);
// fork: two writers race tail e1 — both index 2, both prevHash e1.hash
const e2a = mkEntry(2, "memory.written", { fact: "A" }, e1.hash, t0 + 2000);
const e2b = mkEntry(2, "session.updated", { b: 2 }, e1.hash, t0 + 2000);
// continuation chains off the FIRST branch (as the live chain did at 208)
const e3 = mkEntry(3, "voice.spoken", { c: 3 }, e2a.hash, t0 + 3000);
const forked = [e0, e1, e2a, e2b, e3];
const f1 = join(dir, "forked.jsonl");
fs.writeFileSync(f1, forked.map((e) => JSON.stringify(e)).join("\n") + "\n");

const r1 = runVerify(f1);
check("1a. unannotated fork → hard FAIL", r1.code === 1 && /UNANNOTATED chain fork at index 2/.test(r1.out));

// annotate it (forward entry, never re-chains history)
const ann = mkEntry(4, "chain.fork_annotated", {
  ruling: "test",
  content_verified: true,
  forks: [{ index: 2, positions: [2, 3], branchHashes: [e2a.hash, e2b.hash], siblingKinds: ["memory.written", "session.updated"] }],
}, e3.hash, t0 + 4000);
const f2 = join(dir, "annotated.jsonl");
fs.writeFileSync(f2, [...forked, ann].map((e) => JSON.stringify(e)).join("\n") + "\n");
const r2 = runVerify(f2);
check("1b. annotated fork → PASS GREEN_WITH_NOTED_FORKS", r2.code === 0 && /GREEN with 1 noted fork/.test(r2.out));

// tamper INSIDE an annotated fork branch — must still hard-FAIL
const tampered = [...forked, ann].map((e) => JSON.stringify(e));
tampered[3] = tampered[3].replace('"b":2', '"b":3');
const f3 = join(dir, "tampered.jsonl");
fs.writeFileSync(f3, tampered.join("\n") + "\n");
const r3 = runVerify(f3);
check("1c. tampered fork branch → hard FAIL (tamper)", r3.code === 1 && /payload tampered/.test(r3.out));

// ---- 2. live mutex under concurrency ----
if (!SKIP_LIVE) {
  console.log("=== 2. Live mutex: 24 concurrent session creates ===");
  const ROOT = join(tmpdir(), `argos-chain-mutex-${process.pid}`);
  fs.mkdirSync(ROOT, { recursive: true });
  const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout.on("data", () => {}); server.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${PORT}`;
  const ready = async (maxSec = 90) => {
    for (let i = 0; i < maxSec; i++) {
      const ok = await new Promise((res) => { http.get(new URL("/api/runtime", base), (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)); });
      if (ok) return true;
      await new Promise((rs) => setTimeout(rs, 1000));
    }
    return false;
  };
  try {
    if (!(await ready())) throw new Error("server not ready on " + base);
    const post = (i) => new Promise((res) => {
      const body = JSON.stringify({ title: `mutex-proof-${i}`, personaId: "bartimaeus", model: "x", messages: [] });
      const req = http.request(new URL("/api/chat/sessions", base), { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (r) => { r.resume(); r.on("end", () => res(r.statusCode)); });
      req.on("error", () => res(0));
      req.end(body);
    });
    const codes = await Promise.all(Array.from({ length: 24 }, (_, i) => post(i)));
    const okCount = codes.filter((c) => c === 200 || c === 201).length;
    check(`2a. concurrent POSTs accepted (${okCount}/24)`, okCount >= 20, JSON.stringify(codes));
    const chainFile = join(ROOT, "state", "audit", "chain.jsonl");
    const entries = fs.readFileSync(chainFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    let forks = 0;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].prevHash === entries[i - 1].prevHash && entries[i].index === entries[i - 1].index) forks++;
    }
    check(`2b. ZERO forks after concurrency (entries: ${entries.length})`, forks === 0, `forks=${forks}`);
    const rv = runVerify(chainFile);
    check("2c. chain verifies GREEN (no noted forks needed)", rv.code === 0 && !/noted fork/.test(rv.out));
  } finally {
    try { spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)]); } catch { /* */ }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
  }
} else {
  console.log("=== 2. live mutex SKIPPED (--skip-live) ===");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nproof-chain-ruling: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
