// lib/auth.ts
//
// Operator Auth (2026-05-28) — server-side primitives.
//
// Local-only security model. ARGOS runs on 127.0.0.1; the PIN gate
// keeps a casual passerby out of operator mode (full persona register,
// operator profile in context, project memory). It is not internet-
// grade security and isn't trying to be — SHA-256 with a fixed-string
// salt is sufficient for the threat model (someone with disk access
// can read settings.json anyway).
//
// Server-side: hashPin(), verifyPin(), generateSessionToken(),
// per-process token store. Client-side hashing (window.crypto.subtle)
// lives in lib/auth-client.ts and must produce identical output for
// the same PIN.

import type { NextRequest } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readSettings } from "./settings";
import { isRuntimeTokenValid } from "./runtime-token";

/** Lifetime of a single operator session token. 12 hours per directive.
 *  Tokens are also invalidated on server restart (Set is in-memory). */
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** Fixed-string component of the salt. The PIN length is appended to
 *  this so two different-length PINs with identical prefixes don't
 *  collide. Must match the client-side hash in lib/auth-client.ts. */
const SALT_PREFIX = "ARGOS_OPERATOR_";

/**
 * Hash a PIN. SHA-256 over `SALT_PREFIX + pin.length + pin`, hex
 * encoded. Mirrored exactly by hashPinClient() in lib/auth-client.ts
 * — both sides must produce identical output for the same PIN, or
 * settings.operatorPinHash (written by the client) and the server's
 * verify-time comparison would never match.
 *
 * Pre-condition: pin is the user's plaintext PIN. Caller is expected
 * to validate length (4-8 chars). This function makes no length
 * assumption — pass it any non-empty string.
 */
export function hashPin(pin: string): string {
  const salt = `${SALT_PREFIX}${pin.length}`;
  return createHash("sha256")
    .update(salt)
    .update(pin)
    .digest("hex");
}

/**
 * Constant-time comparison of a candidate PIN's hash against the
 * stored hash. Pass the candidate PIN as plaintext (server-side use
 * only); for the API path, the client sends `pinHash` and the server
 * compares the strings directly via `timingSafeStringEqual`.
 */
export function verifyPin(candidate: string, storedHash: string): boolean {
  if (!candidate || !storedHash) return false;
  const candHash = hashPin(candidate);
  return timingSafeStringEqual(candHash, storedHash);
}

/**
 * Constant-time string comparison. Wraps node:crypto's timingSafeEqual
 * with a length check that itself is NOT timing-safe — but the length
 * leak is on the hash output, which is always 64 hex chars for
 * SHA-256, so this leaks nothing real. Used by /api/auth/verify to
 * compare the client's pinHash payload to settings.operatorPinHash.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Generate a session token. 32 hex chars (16 random bytes). Used as
 * the bearer credential the client stores in sessionStorage and sends
 * with every chat request.
 */
export function generateSessionToken(): string {
  return randomBytes(16).toString("hex");
}

// ----- in-process token store -----
//
// Tokens issued by /api/auth/verify live here until expiry or server
// restart. Single Next.js process means a single Map; multi-process
// would need a shared store (Redis, file) but we're explicitly local-
// single-operator.
//
// Each entry: token → expiry epoch ms.

const activeTokens = new Map<string, number>();

/** Add a freshly issued token with the standard TTL. */
export function registerToken(token: string): void {
  activeTokens.set(token, Date.now() + TOKEN_TTL_MS);
}

/**
 * True if the token is in the active set AND not yet expired.
 * Side-effect: expired tokens are pruned on read so we don't hold
 * indefinitely large maps for long-running processes. Cheap GC.
 */
export function isTokenValid(token: string | null | undefined): boolean {
  if (!token || typeof token !== "string") return false;
  const expiry = activeTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

/** Invalidate a single token (used by the lock-session UI). Silent
 * no-op if the token isn't known. */
export function revokeToken(token: string): void {
  activeTokens.delete(token);
}

/** Wipe every token in the store — used by tests and never in normal
 * operation. Exported so the auth smoke can reset between cases. */
export function _resetTokenStore(): void {
  activeTokens.clear();
}

/**
 * Parse a bearer token from an Authorization header value. Returns
 * the token string, or null if the header is missing/malformed.
 * Tolerates extra whitespace, case-insensitive on the "Bearer" word.
 */
export function parseBearer(authHeader: string | null | undefined): string | null {
  if (!authHeader || typeof authHeader !== "string") return null;
  const m = authHeader.trim().match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
  return m ? m[1] : null;
}

export type AuthFailure = { ok: false; status: number; error: string };

/** Reusable gate for mutating operator endpoints.
 *
 * Returns `null` when the request is authorized.
 * When unauthorized/misconfigured, returns an `AuthFailure` shaped
 * so the caller can return it directly:
 *
 *   const auth = await requireValidSession(req);
 *   if (auth) return NextResponse.json(auth.body, { status: auth.status });
 */
/** Phase 1.5 (2026-06-10) — Rule 8 restoration: the gate for the raw tool
 * endpoints (/api/tools/execute, /api/tools/approve), which are reachable
 * over Tailscale, not just loopback.
 *
 * UNCONDITIONALLY active — unlike requireValidSession() below there is no
 * "PIN not configured" exemption, because that exemption would leave the
 * tool surface open to any Tailscale peer on a fresh/un-PINed install.
 * Authorized callers are:
 *   (a) a PIN-unlocked operator session (Authorization: Bearer <token>), or
 *   (b) a local process holding the runtime token (x-argos-runtime-token
 *       header; token lives at ARGOS_ROOT/state/runtime-token — local disk
 *       only, never served).
 * No bootstrap deadlock: these endpoints are not on the PIN-setup path
 * (/api/settings keeps its own gate), and the runtime token is self-issued
 * with no operator input. See lib/runtime-token.ts for the full frame.
 */
export async function requireToolSession(req: NextRequest): Promise<AuthFailure | null> {
  const bearer = parseBearer(req.headers.get("authorization"));
  if (isTokenValid(bearer)) return null;
  if (await isRuntimeTokenValid(req.headers.get("x-argos-runtime-token"))) {
    return null;
  }
  return { ok: false, status: 401, error: "ACCESS DENIED" };
}

export async function requireValidSession(req: NextRequest): Promise<AuthFailure | null> {
  const settings = await readSettings().catch(() => null);
  const requirePin = settings?.requirePin === true;
  const pinConfigured =
    typeof settings?.operatorPinHash === "string" && settings.operatorPinHash.length > 0;

  // Auth is only ENFORCEABLE once BOTH conditions hold:
  //   (a) the operator opted in           → requirePin === true, AND
  //   (b) a PIN is actually configured     → operatorPinHash is set.
  // Otherwise the request is allowed — the original behavior every prior
  // release relied on.
  //
  // Fix (Phase 7-C, 2026-06-04): commit 5a335b9 returned a 503 here instead,
  // which (a) bricked ALL settings saves out of the box, and (b) created a
  // bootstrapping DEADLOCK. operatorPinHash is set via POST /api/settings —
  // the very endpoint this gate guards — so with requirePin=true and NO PIN
  // configured (the exact state 5a335b9 left on disk), /api/auth/verify can
  // never mint a token (nothing to compare against) and the settings save can
  // never succeed. There is no recovery path. Allowing when the PIN is absent
  // closes the deadlock while keeping the gate fully active for the real
  // "PIN set + requirePin on" case below.
  if (!requirePin || !pinConfigured) {
    return null;
  }

  const bearer = parseBearer(req.headers.get("authorization"));
  if (!isTokenValid(bearer)) {
    return {
      ok: false,
      status: 401,
      error: "ACCESS DENIED",
    };
  }

  return null;
}
