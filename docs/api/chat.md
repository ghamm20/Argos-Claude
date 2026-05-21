# POST /api/chat

Persona-aware chat with optional vault retrieval injection and truth-mode prompt hardening. Streams NDJSON from the Ollama daemon, then appends a `{ "type": "retrieval", ... }` event tail so the client can render citation pills.

## Request

```http
POST /api/chat
Content-Type: application/json
```

```json
{
  "messages": [
    { "role": "user", "content": "What does Rule 3 say about paths?" }
  ],
  "personaId": "bartimaeus",
  "model": "llama3.1:8b-instruct-q4_K_M",
  "useRetrieval": true,
  "topK": 5,
  "truthMode": false
}
```

### Fields

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `messages` | `WireMessage[]` | yes | — | 1–200 messages |
| `messages[].role` | `"user" \| "assistant" \| "system"` | yes | — | Strict enum |
| `messages[].content` | `string` | yes | — | ≤ 100,000 chars per message |
| `personaId` | `"bartimaeus" \| "juniper" \| "cipher"` | yes | — | See `lib/personas.ts` |
| `model` | `string` | yes | — | Must be in `AVAILABLE_MODELS` |
| `useRetrieval` | `boolean` | no | `true` | Set `false` to skip vault lookup |
| `topK` | `number` | no | `5` | 1–50; out-of-range silently defaults |
| `truthMode` | `boolean` | no | `false` | Appends hedging/citation directive to system prompt |

## Response

### Success: `200 OK`

```http
HTTP/1.1 200 OK
Content-Type: application/x-ndjson; charset=utf-8
Cache-Control: no-store, no-transform
X-Content-Type-Options: nosniff
```

NDJSON stream. Two kinds of lines:

**Token frames** (verbatim from Ollama):
```json
{"model":"llama3.1:8b-instruct-q4_K_M","created_at":"2026-05-20T...","message":{"role":"assistant","content":"I"},"done":false}
```

**Retrieval tail** (appended by the chat route after Ollama closes):
```json
{"type":"retrieval","hits":[{"index":1,"text":"...","filename":"seven-rules.md","chunkIndex":2,"score":0.59,"docId":"..."}],"error":null,"enabled":true}
```

When retrieval fails, `hits` is `null` and `error` contains the message.

### Errors

| Status | Body | Cause |
|---|---|---|
| `400` | `{ error: "..." }` | Malformed request (see Validation below) |
| `400` | `{ error: "model not in allowed list", availableModels: [...] }` | Unknown model |
| `400` | `{ error: "unknown persona: ..." }` | Persona not in `PERSONA_BY_ID` |
| `404` | `{ error: "model not found", hint: "ollama pull ...", ollamaBody: "..." }` | Ollama can't find the model |
| `502` | `{ error: "upstream fetch failed: ..." }` | Ollama daemon returned non-2xx |
| `502` | `{ error: "empty stream body from Ollama" }` | Daemon returned 200 but no body |
| `503` | `{ error: "Ollama not reachable at ... Is \`ollama serve\` running?" }` | `ECONNREFUSED` |
| `504` | `{ error: "Ollama did not respond within 60s (first-token timeout)" }` | Daemon hung |

## Validation (Phase O hardening)

- `messages` must be a non-empty array, length ≤ 200
- Each message: `role` ∈ `{user, assistant, system}`, `content` is a string ≤ 100,000 chars
- `model` must pass `isAvailableModel()` (defined in `lib/store.ts`)
- `personaId` must be a key in `PERSONA_BY_ID`
- `topK` is silently clamped to `[1, 50]` if out of range (no error)

## Behavior notes

- The first user message in `messages` (searching from the end) is used as the retrieval query.
- Retrieval failures are non-fatal: the chat continues without RAG context, and the retrieval tail event reports `error: "..."`.
- Truth mode (`truthMode: true`) appends a 6-bullet directive to the system prompt that emphasizes citation discipline and hedging. See `TRUTH_MODE_CLAUSE` in `app/api/chat/route.ts`.
- First-token timeout is 60 seconds. Subsequent tokens have no per-chunk timeout — model can stream indefinitely once it starts producing.

## Example: streaming client

```js
const res = await fetch("/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    messages: [{ role: "user", content: "hi" }],
    personaId: "bartimaeus",
    model: "llama3.1:8b-instruct-q4_K_M",
  }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.type === "retrieval") {
      console.log("citations:", ev.hits);
    } else if (ev.message?.content) {
      process.stdout.write(ev.message.content);
    }
  }
}
```
