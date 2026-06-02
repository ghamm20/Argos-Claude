// lib/web/paths.ts
//
// Web Capability (2026-06-02) — filesystem locations for the shared web/API
// infrastructure, all derived from argosRoot() so they travel with the USB
// payload and obey the Seven USB-Native Rules (no hardcoded absolute paths).

import path from "node:path";
import { argosRoot } from "../vault/paths";

/** Disk-backed cache for external API responses: state/web-cache/<sha1>.json */
export function webCacheDir(): string {
  return path.join(argosRoot(), "state", "web-cache");
}

/** Per-source token-bucket state. */
export function rateLimitsPath(): string {
  return path.join(argosRoot(), "state", "rate-limits.json");
}

/** Append-only external-call audit log. */
export function webAuditPath(): string {
  return path.join(argosRoot(), "state", "web-audit.jsonl");
}

/** Config dir (shared with settings) for the at-rest secret key file. */
export function webConfigDir(): string {
  return path.join(argosRoot(), "config");
}

/** Random per-install key used to encrypt API secrets at rest. */
export function secretKeyPath(): string {
  return path.join(webConfigDir(), ".argos-secret-key");
}
