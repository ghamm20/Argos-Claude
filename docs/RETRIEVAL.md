# Vault & Retrieval

This document covers ARGOS's vault retrieval subsystem: what it is, how it scales, how to tune it, and when to revisit the design.

## Architecture

In-memory cosine similarity over a flat array of `{ text, embedding[], filename, chunkIndex }` records. No external vector database. No SQL. No sidecar process.

**Why this and not Chroma / Faiss / SQLite-vec:** decided in H3.STEP3 (2026-05-18, `methodology/decisions.md`). v1 scope is single-user, single-machine, modest corpus size. A 5000-chunk × 768-dim cosine scan is ~3 ms in V8. Vector-DB upgrade is filed for v2, gated on **chunk count exceeding ~50k** OR **query p95 latency exceeding 100 ms**.

## The flow

```
vault/dropbox/foo.md
     ↓ (launcher → POST /api/vault/auto-ingest)
extract text  →  chunkText()  →  embedText() per chunk  →  persist
                                  ↑
                                  nomic-embed-text (Ollama, 768-dim)
     ↓
vault/index/manifest.json          (document metadata)
vault/index/chunks/<docId>.json    (chunks + embeddings)
vault/docs/<docId>-<filename>      (original)
vault/dropbox/.processed/<ts>__foo.md  (archived original)
```

Retrieval (`retrieve(query, topK, opts)` in `lib/vault/store.ts`):

1. Embed the query string via `embedText` (one call to Ollama)
2. Walk every chunk in the manifest, compute cosine vs query embedding
3. Drop hits below `opts.minConfidence` floor (filter cheaply before allocating hit objects)
4. Sort descending, take top K
5. Each surviving hit gets a `confidence: "high" | "medium" | "low"` bucket

## Confidence thresholds (`lib/vault/types.ts`)

| Bucket | Cosine score | Interpretation |
|---|---|---|
| `high`   | ≥ 0.55 | Strong topical match. Quote-worthy. Cite with confidence. |
| `medium` | ≥ 0.40 | Topical adjacency. Useful as background; flag uncertainty in cited claim. |
| `low`    | ≥ 0.25 | Weak signal. Sage uses it; Bart filters it out. |
| (filtered) | < 0.25 | Probably unrelated. Dropped before reaching the chat route. |

Calibrated against `nomic-embed-text` (768-dim, English-tuned). Distribution observed:

- Strong topical matches typically score 0.55–0.75
- Decent adjacent matches 0.40–0.55
- Weak vibes 0.25–0.40
- Anything below 0.25 is noise

Tunable in `CONFIDENCE_THRESHOLDS` if your corpus presents different score distribution (e.g. heavily code-formatted docs may score differently than prose).

## Per-persona retrieval policy

Each persona in `lib/personas.ts` declares a `retrieval: PersonaRetrieval`:

| Persona | defaultEnabled | topK | minConfidence | Rationale |
|---|:---:|:---:|---|---|
| Bartimaeus | ✓ | 5 | medium | Verification-focused — better to answer from base knowledge than cite a weak match |
| Sage | ✓ | 10 | low | Research/synthesis — surface lots of context, let the model decide |
| Juniper | ✗ | 3 | low | Warm conversational — vault is opt-in per request |
| Bobby | ✗ | 3 | low | Plain-talk — vault is opt-in per request |

**Operator override is always honored.** Setting `body.useRetrieval` (true/false) or `body.topK` on a request supersedes the persona default. Set `useRetrieval: true` on a Bobby request when you want sourcing for one question; persona reverts to default on the next request.

## Auto-ingest

The launcher calls `POST /api/vault/auto-ingest` after `[4/4] ARGOS ready`. Endpoint:

1. Scans `$ARGOS_ROOT/vault/dropbox/` for files (`.txt`, `.md`, `.pdf`, `.docx`)
2. Skips dot-dirs (`.processed/`, `.errored/`) — so re-runs don't process the archive
3. For each file: `ingest()` → on success move to `.processed/<ts>__<filename>`; on failure move to `.errored/<ts>__<filename>`
4. Returns `{ totalFiles, ingested, errored, skipped, records: [...] }`

Operator workflow:

```
drop file.pdf into ARGOS\vault\dropbox\
double-click launcher.bat
→ pulled in automatically; UI shows updated doc count + chunk count in HUD
```

No restart needed mid-session: the operator can also use the existing `POST /api/vault/upload` (multipart form) via the UI's Vault tab. Auto-ingest is for **bulk pre-launch seeding** and **batch refresh**.

## Scaling ceiling (~1000 docs / ~50k chunks)

Current implementation is **disk-IO-bound** at scale, not CPU-bound. Per-query cost breakdown:

| Step | Cost (5k chunks) | Cost (50k chunks) | Notes |
|---|---|---|---|
| `embedText(query)` | ~80 ms | ~80 ms | one Ollama call, constant |
| Read manifest + chunks | ~5 ms | ~50 ms | one JSON read per doc |
| Cosine scan | ~3 ms | ~30 ms | V8 float64 math; linear in chunks |
| Sort + slice | <1 ms | <1 ms | negligible |
| **Total** | ~90 ms | ~160 ms | excludes Ollama queue / cold start |

At ~50k chunks the disk read becomes the bottleneck (a flat `vault/index/chunks/*.json` per doc, each loaded fresh per query). For 100k+ chunks, consider:

- **In-memory chunk cache** (RAM permitting; ~1500 chars × 4 bytes + 768 × 4-byte embedding ≈ 9 KB/chunk → 50k chunks ≈ 450 MB)
- **Single binary chunk store** (mmap-able file) instead of per-doc JSON
- **Eventually: actual vector DB** (Faiss, LanceDB, SQLite-vec). Filed v2-deferred per H3.STEP3.

Practical guidance:

- **Under 1000 docs / 5000 chunks:** current architecture is comfortable. No tuning needed.
- **1000–5000 docs / 5k–50k chunks:** keep an eye on launcher startup time (first cold query) and HUD "Retrieval" latency. If you see p50 > 200 ms, time to consider the in-memory cache.
- **5000+ docs / 50k+ chunks:** revisit. Either swap to a vector DB or accept slower retrieval.

## Failure modes & fallbacks

- **Ollama daemon down** → embed call fails 503; chat route logs warning, proceeds WITHOUT retrieval context. Operator sees retrieval tail event with `error: "..."` and `hits: null`. Chat continues from base model knowledge.
- **Empty vault** → retrieve returns `[]`; chat route injects no retrieval block; system prompt is persona-only.
- **No hits clear the confidence floor** → empty array; chat continues without context. HUD shows "Last: 0 hits" briefly.
- **Auto-ingest fails on a file** → file moves to `vault/dropbox/.errored/<ts>__<filename>`. Operator can inspect, fix, retry by moving back to dropbox/. Errored file does NOT block other files in the same batch.
- **Manifest corruption** → manifest read throws; chat route catches and reports `retrievalError`. To recover: stop ARGOS, delete `vault/index/manifest.json`, restart with all docs in dropbox/ for re-ingest.

## Citation discipline

When retrieval is active and hits are injected into the system prompt, the chat route adds:

```
RELEVANT CONTEXT (cite by [1], [2], etc. when you use this material):
[1] <chunk text> (source: <filename>, chunk <chunkIndex>)
[2] ...

If no chunk is relevant to the user's question, say so plainly and do not invent citations.
```

The persona's system prompt also reinforces "Never fabricate citations" via the `CITATION_RULE` clause.

Truth Mode (operator toggle) appends an additional 6-bullet directive that explicitly says "When you cite [N], the citation must point to a chunk you actually used" + "Do not invent citations or sources."

The combination is doctrine-strict but not foolproof — the underlying model is the last line of defense. The `scripts/smoke-vault-ranking.mjs` benchmark gates against false-citation rate on a known-answer test set.

## See also

- `lib/vault/store.ts` — implementation
- `lib/vault/types.ts` — types + `CONFIDENCE_THRESHOLDS`
- `lib/personas.ts` — per-persona `retrieval` policy
- `app/api/chat/route.ts` — wiring (persona config + minConfidence pass-through)
- `app/api/vault/upload/route.ts` — single-file ingest via UI
- `app/api/vault/auto-ingest/route.ts` — Phase 3 bulk dropbox ingest
- `methodology/decisions.md` — H3.STEP3 in-memory-cosine decision, Phase 3 confidence labels decision
- `docs/api/vault.md` — vault API reference
