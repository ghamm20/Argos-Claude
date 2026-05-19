const OLLAMA_BASE = "http://127.0.0.1:11434";
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
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) {
      throw new EmbedError(
        "Ollama not reachable at 127.0.0.1:11434. Is `ollama serve` running?",
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
