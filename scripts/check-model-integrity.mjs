#!/usr/bin/env node
// check-model-integrity.mjs — Verify that the Ollama model store has
// every blob referenced by every manifest, optionally with hash check.
//
// Surfaced after Phase 2 testing hit "unable to load model" errors that
// were initially mistaken for persona-logic failures but were actually
// model-store integrity issues. Run this BEFORE any persona test
// suite to separate "model loadable" from "persona working."
//
// Usage:
//   node scripts/check-model-integrity.mjs [--root PATH] [--hash] [--model NAME]
//
//   --root PATH    Ollama OLLAMA_MODELS dir (default: $ARGOS_ROOT/models
//                  or process.cwd()/models)
//   --hash         Re-hash every present blob and verify against its
//                  sha256-XXX filename. SLOW for large models (13 GB
//                  Bart takes ~30s on NVMe). Default off; existence-only.
//   --model NAME   Limit to one model namespace match. E.g.,
//                  "huihui_ai/gpt-oss-abliterated:20b" or partial
//                  "HauhauCS". Default: all manifests under the root.
//
// Exit 0 = all manifests' blobs present (+ hash-match if --hash).
// Exit 1 = at least one blob missing or hash mismatch.

import { readFileSync, readdirSync, statSync, existsSync, createReadStream } from "node:fs";
import { join, resolve, basename, sep } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    const v = (i + 1 < args.length && !args[i + 1].startsWith("--")) ? args[++i] : true;
    argMap[k] = v;
  }
}

const ROOT = resolve(
  argMap.root ??
  process.env.OLLAMA_MODELS ??
  join(process.env.ARGOS_ROOT ?? process.cwd(), "models")
);
const HASH_CHECK = Boolean(argMap.hash);
const FILTER = typeof argMap.model === "string" ? argMap.model : null;

console.log(`check-model-integrity`);
console.log(`  root      ${ROOT}`);
console.log(`  mode      ${HASH_CHECK ? "hash-check (slow)" : "existence-only"}`);
if (FILTER) console.log(`  filter    ${FILTER}`);
console.log("");

const manifestsRoot = join(ROOT, "manifests");
const blobsRoot = join(ROOT, "blobs");

if (!existsSync(manifestsRoot)) {
  console.error(`[FAIL] manifests dir missing: ${manifestsRoot}`);
  console.error(`       Set ARGOS_ROOT or OLLAMA_MODELS env, or pass --root <path>.`);
  console.error(`       Typical: ARGOS_ROOT=C:\\Users\\<you>\\Desktop\\ARGOS npm run integrity:check`);
  process.exit(1);
}
if (!existsSync(blobsRoot)) {
  console.error(`[FAIL] blobs dir missing: ${blobsRoot}`);
  process.exit(1);
}

// Walk manifests/ recursively. Every leaf file IS a manifest.
function* walkManifests(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) yield* walkManifests(full);
    else if (ent.isFile()) yield full;
  }
}

function manifestName(absPath) {
  // e.g. ".../manifests/registry.ollama.ai/huihui_ai/gpt-oss-abliterated/20b"
  // → "huihui_ai/gpt-oss-abliterated:20b" (Ollama-style "namespace/model:tag")
  const rel = absPath.slice(manifestsRoot.length + 1).split(sep);
  // Strip the registry segment (first element).
  const parts = rel.slice(1);
  if (parts.length < 2) return rel.join("/");
  const tag = parts.pop();
  return `${parts.join("/")}:${tag}`;
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

function parseDigests(manifestJson) {
  const out = [];
  if (manifestJson.config?.digest) {
    out.push({ role: "config", digest: manifestJson.config.digest, size: manifestJson.config.size });
  }
  for (const l of manifestJson.layers || []) {
    out.push({ role: l.mediaType?.split(".").pop() || "layer", digest: l.digest, size: l.size });
  }
  return out;
}

const allManifests = [...walkManifests(manifestsRoot)];
const filtered = FILTER
  ? allManifests.filter((m) => manifestName(m).includes(FILTER) || m.includes(FILTER))
  : allManifests;

if (filtered.length === 0) {
  console.error(`[FAIL] no manifests matched ${FILTER ? `filter "${FILTER}"` : ""} under ${manifestsRoot}`);
  process.exit(1);
}

let totalManifests = 0;
let totalBlobsChecked = 0;
let totalBlobsMissing = 0;
let totalBlobsHashMismatch = 0;
const perManifest = [];

for (const m of filtered) {
  totalManifests++;
  const name = manifestName(m);
  const raw = readFileSync(m, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`[FAIL] ${name}: manifest is not valid JSON`);
    perManifest.push({ name, ok: false, reason: "invalid JSON" });
    totalBlobsMissing++;
    continue;
  }
  const digests = parseDigests(parsed);
  const blobResults = [];
  let manifestOk = true;
  for (const d of digests) {
    const sha = d.digest.replace(/^sha256:/, "");
    const blobPath = join(blobsRoot, `sha256-${sha}`);
    const present = existsSync(blobPath);
    totalBlobsChecked++;
    if (!present) {
      totalBlobsMissing++;
      manifestOk = false;
      blobResults.push({ role: d.role, sha, ok: false, reason: "MISSING" });
      continue;
    }
    const actualSize = statSync(blobPath).size;
    if (typeof d.size === "number" && actualSize !== d.size) {
      manifestOk = false;
      blobResults.push({
        role: d.role,
        sha,
        ok: false,
        reason: `SIZE MISMATCH (expected ${d.size}, got ${actualSize})`,
      });
      totalBlobsMissing++;
      continue;
    }
    if (HASH_CHECK) {
      const actual = await sha256(blobPath);
      if (actual !== sha) {
        totalBlobsHashMismatch++;
        manifestOk = false;
        blobResults.push({ role: d.role, sha, ok: false, reason: `HASH MISMATCH (computed ${actual})` });
        continue;
      }
      blobResults.push({ role: d.role, sha, ok: true, size: actualSize, hashVerified: true });
    } else {
      blobResults.push({ role: d.role, sha, ok: true, size: actualSize });
    }
  }
  perManifest.push({ name, ok: manifestOk, blobs: blobResults });
  const tag = manifestOk ? "[ok]   " : "[FAIL] ";
  console.log(`${tag} ${name}`);
  for (const b of blobResults) {
    const sym = b.ok ? "ok " : "FAIL";
    const size = b.size != null ? ` (${(b.size / 1024 / 1024).toFixed(1)} MB)` : "";
    const hv = b.hashVerified ? " ✓hash" : "";
    const reason = b.ok ? "" : ` — ${b.reason}`;
    console.log(`   [${sym}] ${b.role.padEnd(10)} sha256:${b.sha.slice(0, 16)}…${size}${hv}${reason}`);
  }
}

console.log("");
console.log(`Summary: ${totalManifests} manifest(s) inspected, ${totalBlobsChecked} blob(s) checked.`);
if (totalBlobsMissing === 0 && totalBlobsHashMismatch === 0) {
  console.log(`ALL CLEAR — every referenced blob is present${HASH_CHECK ? " and hash-verified" : ""}.`);
  process.exit(0);
} else {
  console.log(`FAIL — ${totalBlobsMissing} missing/size-bad, ${totalBlobsHashMismatch} hash-mismatch.`);
  process.exit(1);
}
