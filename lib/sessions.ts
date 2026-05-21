// sessions.ts
//
// Server-side chat session persistence. State lives at
// ARGOS_ROOT/state/sessions/<sessionId>.json — Rule #1 compliant
// (writes only inside ARGOS_ROOT, removable with the drive).
//
// Wire-shape for persisted sessions is deliberately a subset of
// the in-memory ChatMessage (lib/store.ts) — only the fields needed
// to reconstruct a conversation. Streaming flags and transient HUD
// metrics are NOT persisted.
//
// Atomic write pattern: temp file in same dir + fsync + rename.
// Same defense as lib/settings.ts against crash/yank mid-write.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";

export const SESSION_VERSION = 1;
export const MAX_SESSION_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap
export const MAX_SESSIONS_RETURNED = 200; // list endpoint cap

export interface PersistedHit {
  index: number;
  text: string;
  filename: string;
  chunkIndex: number;
  score: number;
  docId: string;
}

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  personaId?: string;
  retrievalHits?: PersistedHit[];
  retrievalError?: string | null;
  errored?: boolean;
}

export interface PersistedSession {
  version: number;
  id: string;
  title: string;
  personaId: string;
  model: string;
  messages: PersistedMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  personaId: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

// ----- paths -----------------------------------------------------

export function sessionsDir(): string {
  return path.join(argosRoot(), "state", "sessions");
}

export function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

// ----- id + title -----------------------------------------------

const ID_ALPHABET = "0123456789abcdef";

/** Generate a 16-char hex id. Stable per call; no collision check. */
export function generateSessionId(): string {
  // Prefer crypto.randomUUID when available (Node 16+, browsers).
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * 16)];
  }
  return s;
}

/**
 * Derive an initial title from the first user message. Capped at
 * 80 chars, single-line. If no user message yet, "New session".
 */
export function deriveTitle(messages: PersistedMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const oneLine = m.content.replace(/\s+/g, " ").trim();
    if (!oneLine) continue;
    return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
  }
  return "New session";
}

// ----- validation ------------------------------------------------

/**
 * Strict shape check. Returns null if invalid (so the caller can
 * surface a 400). Doesn't fix the input — just gates it.
 */
export function validateSession(raw: unknown): PersistedSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id.length === 0 || s.id.length > 128) return null;
  if (typeof s.title !== "string" || s.title.length > 200) return null;
  if (typeof s.personaId !== "string" || s.personaId.length > 64) return null;
  if (typeof s.model !== "string" || s.model.length > 200) return null;
  if (typeof s.createdAt !== "number") return null;
  if (typeof s.updatedAt !== "number") return null;
  if (!Array.isArray(s.messages)) return null;
  if (s.messages.length > 2000) return null;
  for (const m of s.messages) {
    if (!m || typeof m !== "object") return null;
    const msg = m as Record<string, unknown>;
    if (typeof msg.id !== "string") return null;
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "system") return null;
    if (typeof msg.content !== "string") return null;
    if (msg.content.length > 200_000) return null;
    if (typeof msg.timestamp !== "number") return null;
  }
  return {
    version: SESSION_VERSION,
    id: s.id,
    title: s.title,
    personaId: s.personaId,
    model: s.model,
    messages: s.messages as PersistedMessage[],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ----- read/write ------------------------------------------------

/** True if the id contains only safe chars for a filename. */
export function isSafeSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length >= 1 && id.length <= 128;
}

export async function readSession(id: string): Promise<PersistedSession | null> {
  if (!isSafeSessionId(id)) return null;
  try {
    const raw = await fsp.readFile(sessionPath(id), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return validateSession(parsed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeSession(s: PersistedSession): Promise<void> {
  if (!isSafeSessionId(s.id)) {
    throw new Error(`unsafe session id: ${s.id}`);
  }
  const payload = JSON.stringify(s, null, 2);
  if (Buffer.byteLength(payload, "utf8") > MAX_SESSION_SIZE_BYTES) {
    throw new Error(
      `session ${s.id} exceeds ${MAX_SESSION_SIZE_BYTES} byte cap (${Buffer.byteLength(payload, "utf8")} bytes)`
    );
  }
  await fsp.mkdir(sessionsDir(), { recursive: true });
  const finalPath = sessionPath(s.id);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(payload, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmpPath, finalPath);
}

export async function deleteSession(id: string): Promise<boolean> {
  if (!isSafeSessionId(id)) return false;
  try {
    await fsp.unlink(sessionPath(id));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(sessionsDir(), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const summaries: SessionSummary[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".json")) continue;
    // Skip pending atomic-write temp files
    if (ent.name.includes(".tmp")) continue;
    const id = ent.name.slice(0, -".json".length);
    if (!isSafeSessionId(id)) continue;
    try {
      const raw = await fsp.readFile(path.join(sessionsDir(), ent.name), "utf8");
      const parsed = JSON.parse(raw) as PersistedSession;
      const validated = validateSession(parsed);
      if (!validated) continue;
      summaries.push({
        id: validated.id,
        title: validated.title,
        personaId: validated.personaId,
        model: validated.model,
        messageCount: validated.messages.length,
        createdAt: validated.createdAt,
        updatedAt: validated.updatedAt,
      });
    } catch {
      // Corrupted session file — skip but don't break the listing.
      continue;
    }
  }
  // Most recent first.
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries.slice(0, MAX_SESSIONS_RETURNED);
}
