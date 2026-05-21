// ollama-config.ts
//
// Centralizes the Ollama base URL with env override. The launcher sets
// OLLAMA_HOST (which the Ollama daemon also reads) and the app reads the
// same value here so the two stay in sync.
//
// Default: http://127.0.0.1:11434 (matches Ollama's own default).
//
// Tolerates both forms the daemon accepts:
//   OLLAMA_HOST=127.0.0.1:11434
//   OLLAMA_HOST=http://127.0.0.1:11434
//
// Used by:
//   - app/api/chat/route.ts          (chat proxy)
//   - lib/runtime-info.ts            (HUD + AboutSection display)
//   - lib/vault/embed.ts             (vault embedding requests)

const DEFAULT_BASE = "http://127.0.0.1:11434";

export function getOllamaBase(): string {
  const raw = process.env.OLLAMA_HOST;
  if (!raw) return DEFAULT_BASE;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BASE;
  // If it already has a scheme, use as-is. Otherwise prepend http://.
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
  return `http://${trimmed}`.replace(/\/$/, "");
}
