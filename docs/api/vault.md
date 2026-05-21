# /api/vault — Vault routes

Four routes under `/api/vault/*`. All vault state lives under `ARGOS_ROOT/vault/`.

- [GET /api/vault/list](#list)
- [POST /api/vault/upload](#upload)
- [POST /api/vault/search](#search)
- [POST /api/vault/delete](#delete)

---

## list

Lists all ingested documents with their chunk counts.

```http
GET /api/vault/list
```

### Response: `200 OK`

```json
{
  "documents": [
    {
      "docId": "4e5613e9109d2289",
      "filename": "seven-rules.md",
      "byteSize": 1731,
      "chunkCount": 1,
      "ingestedAt": 1779200000000,
      "mimeType": "text/markdown"
    }
  ],
  "totalChunks": 1
}
```

Fields per document:

| Field | Type | Notes |
|---|---|---|
| `docId` | `string` | 16-char hex hash, stable per content |
| `filename` | `string` | Sanitized filename (alnum + `._- `) |
| `byteSize` | `number` | Original file size |
| `chunkCount` | `number` | Chunks the doc was split into |
| `ingestedAt` | `number` | Unix epoch ms |
| `mimeType` | `string` | Detected from extension |

### Errors

GET with no body, no input validation. Returns 200 with empty `documents: []` when the vault is empty.

---

## upload

Ingest a document into the vault. Returns an NDJSON stream of progress events.

```http
POST /api/vault/upload
Content-Type: multipart/form-data
```

Form field: `file` — the document to ingest. Supported: PDF, DOCX, MD, TXT.

### Response: `200 OK` (streaming)

```http
HTTP/1.1 200 OK
Content-Type: application/x-ndjson; charset=utf-8
Cache-Control: no-store
```

NDJSON event stream. Each line is one of:

```json
{"stage":"extracting","filename":"foo.pdf"}
{"stage":"chunking","total":1731}
{"stage":"embedding","current":1,"total":1}
{"stage":"done","result":{"docId":"...","chunkCount":1,"byteSize":1731,...}}
```

Or, on failure:

```json
{"stage":"error","error":"unsupported file type: .xlsx"}
```

The stream always ends with one of `done` or `error`. The connection closes after.

### Validation (Phase O hardening)

- File must be present in the `file` form field
- File size must be ≤ 50 MB (returns `413 Payload Too Large` if exceeded)
- Filename is sanitized: only `[a-zA-Z0-9._\- ]` survive; everything else becomes `_`. After sanitization, must be non-empty.

### Errors

| Status | Body | Cause |
|---|---|---|
| `400` | `{ error: "expected multipart/form-data with 'file' field" }` | Body not multipart |
| `400` | `{ error: "missing 'file' field" }` | Form had no `file` |
| `400` | `{ error: "invalid filename" }` | Empty filename after sanitization |
| `413` | `{ error: "file exceeds 52428800 bytes; got ..." }` | File > 50 MB |

Errors during ingestion (extract / chunk / embed) come back as `{ "stage": "error", "error": "..." }` events in the NDJSON stream, not as HTTP errors. The HTTP status will be 200 even if ingest fails — clients must read the stream to know.

### Ingest pipeline

1. **Extract**: PDF → `pdf-parse`, DOCX → `mammoth`, MD/TXT → utf8 read
2. **Chunk**: split on paragraph boundaries, target ~1500 chars per chunk
3. **Embed**: each chunk → `nomic-embed-text` via Ollama → 768-dim vector
4. **Store**: write to `ARGOS_ROOT/vault/docs/{docId}.json` + `ARGOS_ROOT/vault/index/chunks/{docId}.json`

Typical per-doc latencies (from Phase U stress test against 19-doc corpus):
- p50: 127 ms
- p95: 331 ms
- Sustained throughput: 44 KB/s

---

## search

Cosine-similarity vault search.

```http
POST /api/vault/search
Content-Type: application/json
```

```json
{
  "query": "what does rule 3 say about paths?",
  "topK": 5
}
```

### Fields

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | `string` | yes | — | 1–10,000 chars (Phase O hardening) |
| `topK` | `number` | no | `5` | 1–50; out-of-range silently clamps |

### Response: `200 OK`

```json
{
  "hits": [
    {
      "docId": "4e5613e9109d2289",
      "filename": "seven-rules.md",
      "chunkIndex": 2,
      "text": "Rule 3 — Relative paths only. Never hardcode user paths...",
      "score": 0.5981
    }
  ]
}
```

`score` is cosine similarity (0–1, higher is better). Empty `hits: []` is a valid response when no docs are indexed or no chunks pass the score threshold.

### Errors

| Status | Body | Cause |
|---|---|---|
| `400` | `{ error: "invalid JSON body" }` | Body wasn't parseable JSON |
| `400` | `{ error: "query required" }` | Missing or non-string `query` |
| `400` | `{ error: "query exceeds 10000 chars; got ..." }` | Phase O upper-bound |
| `502` | `{ error: "Ollama not reachable at ..." }` | Can't reach the embedder |
| `502+` | `{ error: "..." }` | Embed model error (passed through with `EmbedError.status`) |

---

## delete

Remove a document and its chunks from the vault.

```http
POST /api/vault/delete
Content-Type: application/json
```

```json
{
  "docId": "4e5613e9109d2289"
}
```

### Response: `200 OK`

```json
{
  "ok": true,
  "removed": true
}
```

`removed` is `false` if the docId wasn't found in the index (the request still succeeds — idempotent).

### Validation

- `docId` is required and must be a string
- `docId` must be ≤ 128 chars (Phase O hardening)

### Errors

| Status | Body | Cause |
|---|---|---|
| `400` | `{ error: "invalid JSON body" }` | Body wasn't parseable JSON |
| `400` | `{ error: "docId required" }` | Missing or non-string `docId` |
| `400` | `{ error: "docId too long ..." }` | > 128 chars |

### What gets removed

- `ARGOS_ROOT/vault/docs/{docId}.json` (extracted text + metadata)
- `ARGOS_ROOT/vault/index/chunks/{docId}.json` (chunks + embeddings)
- In-memory index is rebuilt on the next search

If only one of the two files exists (e.g., a partially-ingested doc), delete will remove whichever is present and return `removed: true`.
