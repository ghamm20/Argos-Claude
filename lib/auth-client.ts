// lib/auth-client.ts
//
// Operator Auth — client-side PIN hashing.
//
// Uses window.crypto.subtle to compute SHA-256 in the browser. Output
// MUST byte-equal the server's hashPin() in lib/auth.ts — same salt
// format, same encoding. If they ever drift, settings.operatorPinHash
// (written by the client) and the server's verify-time comparison
// stop matching.
//
// Why duplicate the algorithm rather than share lib/auth.ts directly:
// lib/auth.ts pulls in node:crypto, which Next.js refuses to bundle
// into a client component. The salt format is locked here as a
// constant to make the divergence audit-able.

const SALT_PREFIX = "ARGOS_OPERATOR_";

/**
 * Hash a PIN in the browser. Same algorithm as server hashPin():
 * SHA-256 over `SALT_PREFIX + pin.length + pin`, hex-encoded.
 *
 * Resolves to the 64-character hex string. Throws if window.crypto.subtle
 * isn't available (very old browser; ARGOS targets modern Chrome).
 */
export async function hashPinClient(pin: string): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("hashPinClient is browser-only");
  }
  if (!window.crypto?.subtle) {
    throw new Error(
      "window.crypto.subtle not available — modern browser required"
    );
  }
  const salt = `${SALT_PREFIX}${pin.length}`;
  const enc = new TextEncoder();
  const buf = await window.crypto.subtle.digest(
    "SHA-256",
    enc.encode(salt + pin)
  );
  // Hex-encode the 32-byte digest. Matches node:crypto's .digest("hex")
  // output byte-for-byte.
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** localStorage key for the legacy persisted token (not used yet —
 *  sessionStorage is the canonical store per directive). Exported so
 *  any future "remember me" feature has a stable key name. */
export const SESSION_STORAGE_TOKEN_KEY = "argos_session_token";

/** Read the active session token from sessionStorage. Returns null if
 *  unset or storage is blocked. */
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage?.getItem(SESSION_STORAGE_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.setItem(SESSION_STORAGE_TOKEN_KEY, token);
  } catch {
    /* private mode or storage disabled — token only lives for the
       current page lifetime, which means the operator gets re-prompted
       on every navigation. Acceptable degradation. */
  }
}

export function clearSessionToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.removeItem(SESSION_STORAGE_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
