// lib/web/secrets.ts
//
// Web Capability TIER 0 (2026-06-02) — at-rest encryption for API secrets
// (currently the GitHub PAT). AES-256-GCM with a random per-install key stored
// at config/.argos-secret-key (generated on first use). settings.json holds
// only ciphertext; the GET /api/settings response masks it; tools decrypt
// server-side via getApiKey().
//
// HONEST scope: this protects against casual reading of settings.json (e.g. if
// the file is synced or shared). It does NOT defend against an attacker with
// full read access to the ARGOS_ROOT, because the key lives in a sibling file
// — true secret isolation needs a master password ARGOS doesn't currently
// prompt for. This matches the doctrine of "encrypted at rest" without
// pretending to be a hardware vault.

import { promises as fsp } from "node:fs";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import path from "node:path";
import { secretKeyPath, webConfigDir } from "./paths";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:"; // marks an encrypted value

let keyCache: Buffer | null = null;

async function loadOrCreateKey(): Promise<Buffer> {
  if (keyCache) return keyCache;
  try {
    const raw = await fsp.readFile(secretKeyPath(), "utf8");
    const buf = Buffer.from(raw.trim(), "hex");
    if (buf.length === 32) {
      keyCache = buf;
      return buf;
    }
  } catch {
    /* not present yet → create */
  }
  const key = randomBytes(32);
  await fsp.mkdir(webConfigDir(), { recursive: true });
  const tmp = path.join(webConfigDir(), `.argos-secret-key.${process.pid}.tmp`);
  await fsp.writeFile(tmp, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, secretKeyPath());
  keyCache = key;
  return key;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypt a plaintext secret → "enc:v1:<ivHex>:<tagHex>:<cipherHex>". */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decrypt a value produced by encryptSecret(). Returns null on any failure or
 *  if the value isn't encrypted (so callers can pass through plaintext too). */
export async function decryptSecret(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  if (!isEncrypted(value)) return value; // tolerate legacy plaintext
  try {
    const rest = value.slice(PREFIX.length);
    const [ivHex, tagHex, dataHex] = rest.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = await loadOrCreateKey();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

/** A safe display hint: last 4 chars only, never the secret. */
export function maskSecret(plaintextOrCipher: string | null | undefined): string | null {
  if (!plaintextOrCipher) return null;
  // If we only have ciphertext we can't show real chars; return a generic mask.
  if (isEncrypted(plaintextOrCipher)) return "••••••••";
  const s = plaintextOrCipher;
  if (s.length <= 4) return "••••";
  return `••••${s.slice(-4)}`;
}
