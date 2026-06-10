// lib/chat/wire.ts
//
// Phase 2 (2026-06-10) — chat-orchestrator extraction. Wire-level types,
// input bounds, and small transport helpers moved VERBATIM from
// app/api/chat/route.ts. No logic changes.

import type { PersonaId } from "@/lib/personas";

export const FIRST_TOKEN_TIMEOUT_MS = 60_000;
export const DEFAULT_TOP_K = 5;
// Input bounds — defense against pathological clients and accidental
// huge histories. The chat route is local-only by Seven Rules but
// defensive bounds keep a stuck client from OOMing the daemon.
export const MAX_MESSAGES = 200;
export const MAX_CONTENT_LENGTH = 100_000; // 100 KB per message
export const VALID_ROLES = new Set<WireRole>(["user", "assistant", "system"]);

export type WireRole = "user" | "assistant" | "system";

export interface WireMessage {
  role: WireRole;
  content: string;
  /** Vision Phase 1 — base64 (data-URL or raw) images on a user turn. */
  images?: string[];
  /** v2.3.9 — tool results the client already received on an assistant turn.
   *  Used to surface prior tool outcomes to the model + drive the
   *  misrepresentation guard. NOT forwarded to Ollama (ollamaMessages maps
   *  only role/content/images). */
  toolResults?: Array<{ toolId?: string; ok?: boolean; summary?: string | null; data?: unknown; error?: string | null }>;
}

// Vision bounds — images are large; keep them off the 100 KB content cap but
// still bounded so a stuck client can't OOM the daemon.
export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGE_CHARS = 15 * 1024 * 1024; // ~11 MB binary as base64

export interface ChatRequestBody {
  messages: WireMessage[];
  personaId: PersonaId;
  model: string;
  useRetrieval?: boolean;
  topK?: number;
  truthMode?: boolean;
  /** Phase 3 (2026-06-10) — chat session id for the observation corpus.
   *  Optional + additive: older clients omit it and nothing changes. */
  sessionId?: string | null;
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error, ...extra }, { status });
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || /aborted|abort/i.test(e.message))
  );
}

export function isConnRefused(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  return /ECONNREFUSED|fetch failed|other side closed|ENOTFOUND/i.test(msg);
}

/** v2.4.2 Phase A — replay a complete (non-streamed) Nous answer as a single
 *  Ollama-shaped NDJSON content frame + a final done frame. The existing stream
 *  reader/accumulator path then handles the Nous response IDENTICALLY to a local
 *  Ollama stream — same wire format to the client, same downstream integrity
 *  evaluation. */
export function makeSyntheticReader(
  content: string
): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  const rs = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        enc.encode(JSON.stringify({ message: { content }, done: false }) + "\n")
      );
      c.enqueue(enc.encode(JSON.stringify({ done: true }) + "\n"));
      c.close();
    },
  });
  return rs.getReader();
}

export function lastUserText(msgs: WireMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].content;
  }
  return null;
}

/** The user message BEFORE the most recent one — the query for an explicit
 *  "go look it up" request, whose literal text isn't the thing to search. */
export function priorUserText(msgs: WireMessage[]): string | null {
  let seenLast = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    if (seenLast) return msgs[i].content;
    seenLast = true;
  }
  return null;
}
