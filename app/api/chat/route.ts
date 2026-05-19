import { NextRequest } from "next/server";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";
import { retrieve } from "@/lib/vault/store";
import type { RetrievalHit } from "@/lib/vault/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const OLLAMA_CHAT = `${OLLAMA_BASE}/api/chat`;
const FIRST_TOKEN_TIMEOUT_MS = 60_000;
const DEFAULT_TOP_K = 5;

type WireRole = "user" | "assistant" | "system";

interface WireMessage {
  role: WireRole;
  content: string;
}

interface ChatRequestBody {
  messages: WireMessage[];
  personaId: PersonaId;
  model: string;
  useRetrieval?: boolean;
  topK?: number;
}

interface CitedHit {
  index: number;
  text: string;
  filename: string;
  chunkIndex: number;
  score: number;
  docId: string;
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error, ...extra }, { status });
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || /aborted|abort/i.test(e.message))
  );
}

function isConnRefused(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  return /ECONNREFUSED|fetch failed|other side closed|ENOTFOUND/i.test(msg);
}

function lastUserText(msgs: WireMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].content;
  }
  return null;
}

function buildRetrievalBlock(hits: RetrievalHit[]): string {
  const lines = hits.map((h, i) => {
    const idx = i + 1;
    const cleaned = h.text.replace(/\s+/g, " ").trim();
    return `[${idx}] ${cleaned} (source: ${h.filename}, chunk ${h.chunkIndex})`;
  });
  return [
    "RELEVANT CONTEXT (cite by [1], [2], etc. when you use this material):",
    ...lines,
    "",
    "If no chunk is relevant to the user's question, say so plainly and do not invent citations.",
  ].join("\n");
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "messages must be a non-empty array");
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return jsonError(400, "model is required");
  }
  const persona = PERSONA_BY_ID[body.personaId];
  if (!persona) {
    return jsonError(400, `unknown persona: ${String(body.personaId)}`);
  }

  // ---- Retrieval (graceful: never breaks the chat) ----
  const wantsRetrieval = body.useRetrieval !== false;
  const topK =
    typeof body.topK === "number" && body.topK > 0 && body.topK <= 50
      ? body.topK
      : DEFAULT_TOP_K;

  let retrievedHits: RetrievalHit[] = [];
  let retrievalError: string | null = null;
  const queryText = wantsRetrieval ? lastUserText(body.messages) : null;
  if (wantsRetrieval && queryText) {
    try {
      retrievedHits = await retrieve(queryText, topK);
    } catch (e) {
      retrievalError = e instanceof Error ? e.message : String(e);
      console.warn(`[chat] retrieval failed, continuing without context: ${retrievalError}`);
    }
  }

  // ---- System prompt construction ----
  const systemParts: string[] = [persona.systemPrompt];
  if (retrievedHits.length > 0) {
    systemParts.push(buildRetrievalBlock(retrievedHits));
  }
  const systemPrompt = systemParts.join("\n\n");

  const ollamaMessages: WireMessage[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // ---- Open Ollama stream ----
  const controller = new AbortController();
  const firstTokenTimer = setTimeout(() => {
    controller.abort();
  }, FIRST_TOKEN_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(OLLAMA_CHAT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: body.model,
        messages: ollamaMessages,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(firstTokenTimer);
    if (isAbortError(e)) {
      return jsonError(504, "Ollama did not respond within 60s (first-token timeout)");
    }
    if (isConnRefused(e)) {
      return jsonError(
        503,
        "Ollama not reachable at 127.0.0.1:11434. Is `ollama serve` running?"
      );
    }
    return jsonError(502, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!upstream.ok) {
    clearTimeout(firstTokenTimer);
    const errBody = await upstream.text();
    if (upstream.status === 404 || /not found|no such model/i.test(errBody)) {
      return jsonError(404, `model not found: ${body.model}`, {
        hint: `Run: ollama pull ${body.model}`,
        ollamaBody: errBody,
      });
    }
    return jsonError(upstream.status, `ollama error ${upstream.status}`, {
      ollamaBody: errBody,
    });
  }
  if (!upstream.body) {
    clearTimeout(firstTokenTimer);
    return jsonError(502, "empty stream body from Ollama");
  }

  // Build the retrieval event we'll emit after Ollama closes.
  const citedHits: CitedHit[] = retrievedHits.map((h, i) => ({
    index: i + 1,
    text: h.text,
    filename: h.filename,
    chunkIndex: h.chunkIndex,
    score: h.score,
    docId: h.docId,
  }));
  const retrievalEvent = {
    type: "retrieval" as const,
    hits: retrievalError === null ? citedHits : null,
    error: retrievalError,
    enabled: wantsRetrieval,
  };

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controllerInner) {
      let receivedAny = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!receivedAny) {
            receivedAny = true;
            clearTimeout(firstTokenTimer);
          }
          if (value) controllerInner.enqueue(value);
        }
        // Tail the stream with our retrieval set so the client can render pills.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(retrievalEvent)}\n`)
        );
        controllerInner.close();
      } catch (e) {
        clearTimeout(firstTokenTimer);
        if (isAbortError(e)) {
          controllerInner.close();
        } else {
          controllerInner.error(e);
        }
      }
    },
    cancel(reason) {
      clearTimeout(firstTokenTimer);
      reader.cancel(reason).catch(() => undefined);
      controller.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
