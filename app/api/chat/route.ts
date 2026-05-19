import { NextRequest } from "next/server";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const OLLAMA_CHAT = `${OLLAMA_BASE}/api/chat`;
const FIRST_TOKEN_TIMEOUT_MS = 60_000;

type WireRole = "user" | "assistant" | "system";

interface WireMessage {
  role: WireRole;
  content: string;
}

interface ChatRequestBody {
  messages: WireMessage[];
  personaId: PersonaId;
  model: string;
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

  const ollamaMessages: WireMessage[] = [
    { role: "system", content: persona.systemPrompt },
    ...body.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

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

  const reader = upstream.body.getReader();
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
