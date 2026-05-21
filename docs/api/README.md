# API Reference

All routes are loopback-only by Seven Rules Rule #5. Authentication and authorization rely on loopback binding — there is no JWT, no API key, no per-route auth check. Anything that can reach `127.0.0.1:7799` is trusted.

| Method | Path | Purpose | Doc |
|---|---|---|---|
| POST | `/api/chat` | Persona-aware chat with vault retrieval + truth mode | [chat.md](./chat.md) |
| GET | `/api/hardware` | Detected hardware profile + recommended model | [hardware.md](./hardware.md) |
| GET, POST | `/api/settings` | Read or patch user settings | [settings.md](./settings.md) |
| GET | `/api/vault/list` | List all ingested documents | [vault.md](./vault.md#list) |
| POST | `/api/vault/upload` | Ingest a new document (NDJSON stream) | [vault.md](./vault.md#upload) |
| POST | `/api/vault/search` | Cosine-similarity vault search | [vault.md](./vault.md#search) |
| POST | `/api/vault/delete` | Remove a document by docId | [vault.md](./vault.md#delete) |

All routes return JSON unless explicitly noted (`/api/chat` and `/api/vault/upload` use `application/x-ndjson` for streaming responses).

Common 4xx codes:
- `400` — malformed request body, missing required field, or unknown enum value
- `404` — resource missing (model not pulled, doc not in vault)
- `413` — payload too large (vault/upload > 50 MB)

Common 5xx codes:
- `502` — upstream (Ollama daemon) returned an error
- `503` — upstream not reachable (`ECONNREFUSED` to Ollama)
- `504` — first-token timeout (60s for chat)
- `500` — unexpected internal error
