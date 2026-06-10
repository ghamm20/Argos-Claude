// lib/runtime-token.ts
//
// Phase 1.5 (2026-06-10) — Rule 8 restoration: the local runtime token.
//
// Threat frame: port 7799 is served over Tailscale, not loopback-only. The
// mutating tool endpoints (/api/tools/execute, /api/tools/approve) must
// reject any caller that is neither (a) a PIN-unlocked operator session nor
// (b) a process running on THIS machine. (b) is proven by possession of a
// random token stored at ARGOS_ROOT/state/runtime-token — readable from
// local disk, never served over HTTP. A Tailscale peer can reach the port
// but cannot read the file.
//
// Why this cannot reproduce the v2.4.1 bootstrap deadlock: the deadlock was
// /api/settings POST guarding the very endpoint that configures the PIN.
// The tools endpoints are not on the auth bootstrap path, and the runtime
// token is self-issued (create-or-load on first use) with no operator input.
//
// Lifecycle: create-or-load. First reader (server gate or a local smoke
// script via scripts/lib/runtime-token.mjs — same algorithm) generates 16
// random bytes hex-encoded and writes the file; everyone after loads it.
// Rotation = delete the file and restart. The file lives under /state/
// (gitignored, travels with the USB payload — Seven Rules compliant).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { argosRoot } from "./vault/paths";

const TOKEN_RE = /^[a-f0-9]{32}$/i;

export function runtimeTokenPath(): string {
  return path.join(argosRoot(), "state", "runtime-token");
}

/** Load the runtime token, creating it on first use. Always reads the file
 *  (no module cache) so a token written by a sibling local process — e.g. a
 *  smoke script that booted before the first gated request — is honored. */
export async function ensureRuntimeToken(): Promise<string> {
  const p = runtimeTokenPath();
  try {
    const existing = (await fsp.readFile(p, "utf8")).trim();
    if (TOKEN_RE.test(existing)) return existing;
  } catch {
    /* missing or unreadable — issue a fresh one below */
  }
  const token = randomBytes(16).toString("hex");
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, token + "\n", "utf8");
  return token;
}

/** Constant-time check of a candidate against the on-disk runtime token. */
export async function isRuntimeTokenValid(
  candidate: string | null | undefined
): Promise<boolean> {
  if (!candidate || typeof candidate !== "string") return false;
  const token = await ensureRuntimeToken();
  const a = Buffer.from(candidate.trim(), "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
