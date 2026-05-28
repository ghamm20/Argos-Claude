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

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
 *  no-op if the token isn't known. */
export function revokeToken(token: string): void {
  activeTokens.delete(token);
}

/** Wipe every token in the store — used by tests and never in normal
 *  operation. Exported so the auth smoke can reset between cases. */
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
