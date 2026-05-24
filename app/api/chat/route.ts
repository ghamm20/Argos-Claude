import { NextRequest } from "next/server";
import { PERSONA_BY_ID, isPersonaSelectable, type PersonaId } from "@/lib/personas";
import { retrieve } from "@/lib/vault/store";
import type { Confidence, RetrievalHit } from "@/lib/vault/types";
import { AVAILABLE_MODELS, isAvailableModel } from "@/lib/store";
import { getOllamaBase } from "@/lib/ollama-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OLLAMA_BASE = getOllamaBase();
const OLLAMA_CHAT = `${OLLAMA_BASE}/api/chat`;
const FIRST_TOKEN_TIMEOUT_MS = 60_000;
const DEFAULT_TOP_K = 5;
// Input bounds — defense against pathological clients and accidental
// huge histories. The chat route is local-only by Seven Rules but
// defensive bounds keep a stuck client from OOMing the daemon.
const MAX_MESSAGES = 200;
const MAX_CONTENT_LENGTH = 100_000; // 100 KB per message
const VALID_ROLES = new Set<WireRole>(["user", "assistant", "system"]);

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
  truthMode?: boolean;
}

const TRUTH_MODE_CLAUSE = [
  "",
  "TRUTH MODE ACTIVE:",
  "- Explicitly surface uncertainty when present.",
  "- Hedge claims that aren't directly supported by retrieval context (prefer \"the source suggests\" or \"based on the available material\" over \"it is\").",
  "- When you cite [N], the citation must point to a chunk you actually used.",
  "- If you don't know, say \"I don't know\" instead of speculating.",
  "- Do not invent citations or sources.",
].join("\n");

interface CitedHit {
  index: number;
  text: string;
  filename: string;
  chunkIndex: number;
  score: number;
  /** Phase 3: bucketed confidence — "high" | "medium" | "low" */
  confidence: Confidence;
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
  if (body.messages.length > MAX_MESSAGES) {
    return jsonError(400, `too many messages (max ${MAX_MESSAGES}, got ${body.messages.length})`);
  }
  // Per-message validation: role + content type + content length.
  // Catches malformed clients before they hit the daemon.
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!m || typeof m !== "object") {
      return jsonError(400, `messages[${i}] must be an object`);
    }
    if (typeof m.role !== "string" || !VALID_ROLES.has(m.role as WireRole)) {
      return jsonError(400, `messages[${i}].role must be one of user|assistant|system`);
    }
    if (typeof m.content !== "string") {
      return jsonError(400, `messages[${i}].content must be a string`);
    }
    if (m.content.length > MAX_CONTENT_LENGTH) {
      return jsonError(
        400,
        `messages[${i}].content exceeds ${MAX_CONTENT_LENGTH} chars (got ${m.content.length})`
      );
    }
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return jsonError(400, "model is required");
  }
  if (!isAvailableModel(body.model)) {
    return jsonError(400, `model not in allowed list: ${body.model}`, {
      availableModels: AVAILABLE_MODELS,
    });
  }
  const persona = PERSONA_BY_ID[body.personaId];
  if (!persona) {
    return jsonError(400, `unknown persona: ${String(body.personaId)}`);
  }
  // Phase 2-RB: refuse to dispatch a chat for a persona whose model
  // isn't wired. Doctrine: never fake a model-backed persona; let the
  // UI render an honest "not configured" state instead of a vague
  // 404 from Ollama. The store's switchPersona already blocks the UI
  // path; this is the API-level enforcement.
  if (!isPersonaSelectable(persona)) {
    return jsonError(
      503,
      `persona "${persona.name}" is not configured (no validated model wired)`,
      {
        hint: persona.intendedModel
          ? `Install ${persona.intendedModel} into Ollama and re-bind in lib/personas.ts, or pick a different persona.`
          : `No intended model recorded. Pick a different persona.`,
      }
    );
  }

  // ---- Retrieval (graceful: never breaks the chat) ----
  // Phase 3: persona's retrieval config supplies defaults when request
  // body doesn't override. Explicit body fields still win — operator can
  // force retrieval on a normally-no-retrieval persona (Bobby/Juniper),
  // or bump topK above persona default, or disable on Bart/Sage.
  const wantsRetrieval =
    body.useRetrieval !== undefined
      ? body.useRetrieval !== false
      : persona.retrieval.defaultEnabled;
  const topK =
    typeof body.topK === "number" && body.topK > 0 && body.topK <= 50
      ? body.topK
      : persona.retrieval.topK ?? DEFAULT_TOP_K;
  const minConfidence = persona.retrieval.minConfidence;

  let retrievedHits: RetrievalHit[] = [];
  let retrievalError: string | null = null;
  const queryText = wantsRetrieval ? lastUserText(body.messages) : null;
  if (wantsRetrieval && queryText) {
    try {
      retrievedHits = await retrieve(queryText, topK, { minConfidence });
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
  if (body.truthMode === true) {
    systemParts.push(TRUTH_MODE_CLAUSE);
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
        // Phase 2-RB CRITICAL: e4b (gemma4 family) ships with the
        // `thinking` capability enabled by default — if `think` is not
        // explicitly false, the model emits its entire response into
        // `message.thinking` and zero into `message.content`. We display
        // content only; thinking traces aren't part of the persona UX.
        // Validation harness (scripts/validate-e4b.mjs) caught this:
        // prompt D returned 637 tokens at 21 tok/s with empty content
        // until `think:false` was added.
        // Safe for non-thinking models too — Ollama ignores the flag.
        think: false,
        options: { think: false },
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
        `Ollama not reachable at ${OLLAMA_BASE}. Is \`ollama serve\` running?`
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
    confidence: h.confidence,
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
