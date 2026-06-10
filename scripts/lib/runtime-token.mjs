// scripts/lib/runtime-token.mjs
//
// Phase 1.5 (2026-06-10) — Rule 8 restoration: script-side access to the
// local runtime token. /api/tools/execute and /api/tools/approve now reject
// any POST that lacks a valid operator session bearer OR this token in the
// x-argos-runtime-token header. Local smoke/proof scripts qualify as local
// processes: they read (create-or-load) ARGOS_ROOT/state/runtime-token with
// the SAME algorithm as lib/runtime-token.ts, so whichever side touches it
// first issues it and both converge on one value.
//
// Usage:
//   import { runtimeToken, runtimeTokenHeader } from "./lib/runtime-token.mjs";
//   const headers = { "content-type": "application/json", ...runtimeTokenHeader(root) };
// `root` must be the SAME ARGOS_ROOT the target server runs under
// (the tmp root the script spawned it with, or the repo root by default).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const TOKEN_RE = /^[a-f0-9]{32}$/i;

export function runtimeToken(root) {
  const p = join(root, "state", "runtime-token");
  try {
    const existing = readFileSync(p, "utf8").trim();
    if (TOKEN_RE.test(existing)) return existing;
  } catch {
    /* missing — issue below */
  }
  const token = randomBytes(16).toString("hex");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, token + "\n", "utf8");
  return token;
}

export function runtimeTokenHeader(root) {
  return { "x-argos-runtime-token": runtimeToken(root) };
}
