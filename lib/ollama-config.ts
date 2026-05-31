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

/**
 * Translate a daemon BIND address into a client CONNECT address.
 *
 * Ollama's daemon legitimately binds to 0.0.0.0 ("listen on all
 * interfaces") when the operator wants LAN access — but clients
 * cannot dial 0.0.0.0; they need a real address. Rewrite to
 * loopback for client use. Same logic for IPv6 unspecified.
 *
 * Phase 2 Persona Completion (2026-05-28): bug surfaced during the
 * persona-roster validation — `OLLAMA_HOST=0.0.0.0` was set in the
 * shell env and every request to http://0.0.0.0 was failing with
 * "Ollama not reachable". The daemon was up and listening; the
 * client just couldn't dial its own bind address.
 */
function bindToConnect(host: string): string {
  if (host === "0.0.0.0" || host === "[::]" || host === "::") return "127.0.0.1";
  return host;
}

export function getOllamaBase(): string {
  const raw = process.env.OLLAMA_HOST;
  if (!raw) return DEFAULT_BASE;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BASE;
  // If it already has a scheme, parse to swap the bind host for a
  // connectable one without mangling port/path.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      u.hostname = bindToConnect(u.hostname);
      return u.toString().replace(/\/$/, "");
    } catch {
      return trimmed.replace(/\/$/, "");
    }
  }
  // Bare host[:port] form. Split on last colon so an IPv6 literal
  // (already wrapped in brackets) survives. If there's no port,
  // append Ollama's default (11434) — without it, e.g. setting
  // OLLAMA_HOST=0.0.0.0 yields http://127.0.0.1 (no port) and the
  // client misses the daemon entirely. The Ollama daemon defaults
  // to 11434 even when the operator sets only a bind address.
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(trimmed.slice(lastColon + 1))) {
    const host = trimmed.slice(0, lastColon);
    const port = trimmed.slice(lastColon);
    return `http://${bindToConnect(host)}${port}`;
  }
  return `http://${bindToConnect(trimmed)}:11434`;
}
