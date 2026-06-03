import { getOllamaBase, KEEP_ALIVE_BACKGROUND } from "../ollama-config";

const OLLAMA_BASE = getOllamaBase();
export const EMBED_MODEL = "nomic-embed-text";

export class EmbedError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbedError";
    this.status = status;
  }
}

interface EmbeddingResponse {
  embedding?: number[];
  error?: string;
}

export async function embedText(text: string): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Background embedding — release VRAM fast so the tiny embed model never
      // holds the conversational persona's slot (keep-alive coordination).
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text, keep_alive: KEEP_ALIVE_BACKGROUND }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) {
      throw new EmbedError(
        `Ollama not reachable at ${OLLAMA_BASE}. Is \`ollama serve\` running?`,
        503
      );
    }
    throw new EmbedError(`embedding upstream error: ${msg}`, 502);
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404 || /not found|no such model/i.test(body)) {
      throw new EmbedError(
        `embed model not found: ${EMBED_MODEL}. Run: ollama pull ${EMBED_MODEL}`,
        404
      );
    }
    throw new EmbedError(`embedding failed ${res.status}: ${body}`, res.status);
  }

  const json = (await res.json()) as EmbeddingResponse;
  if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
    throw new EmbedError(
      "embedding response missing embedding array",
      502
    );
  }
  return json.embedding;
}

export async function embedBatch(
  texts: string[],
  onProgress?: (current: number, total: number) => void
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embedText(texts[i]));
    onProgress?.(i + 1, texts.length);
  }
  return out;
}
