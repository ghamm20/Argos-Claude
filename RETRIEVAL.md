# ARGOS Retrieval Architecture

> Quick reference per Phase 3 directive (2026-05-25). The authoritative deep-dive lives at [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md) — that's where the rationale, scaling math, decision-history, and tuning advice live. This file is the bedside summary.

## Design

In-memory cosine similarity. No external vector database.

Embeddings generated via Ollama `/api/embeddings` with the dedicated `nomic-embed-text` model (768-dim, ~274 MB). **Not** the currently-loaded chat model — that would break on persona switches (different chat models produce different-dimensional vectors that can't be compared). See [`PHASE_3_INVENTORY.md` §4](PHASE_3_INVENTORY.md) for the long version.

Index rebuilt incrementally on `vault/raw/` ingest (POST `/api/vault/auto-ingest` fires from the launcher on boot). Unchanged files (SHA-256 match) are skipped.

## Scaling ceiling

~1000 documents / ~50,000 chunks before RAM becomes a constraint on commodity hardware. At that scale, consider migrating to a persistent vector store (e.g., LanceDB, Qdrant local).

For the current use case (operational SOPs, contracts, post orders), ceiling is not a concern.

The harder metric: query p95 latency >100 ms over the full index. At 5000 chunks × 768-dim cosine scan that's ~3 ms in V8. Plenty of headroom.

## Confidence thresholds

Calibrated against `nomic-embed-text` observed distribution on operational text:

```
HIGH:   score >= 0.55     strong topical match (quote-worthy)
MEDIUM: score >= 0.40     topical adjacency (useful background)
LOW:    score >= 0.25     weak vibes (Sage uses, Bart filters)
NOISE:  score <  0.25     dropped (never returned)
```

Directive's stricter scheme (HIGH≥0.80) would mark almost no result as HIGH on this corpus. The conservative current thresholds let real matches surface; tune in `lib/vault/types.ts:CONFIDENCE_THRESHOLDS` if your corpus presents a different distribution.

## Adding documents

Drop files into `vault/raw/` (canonical) OR `vault/dropbox/` (legacy back-compat — still scanned). Supported: `.txt`, `.md`, `.pdf`, `.docx`. Restart launcher to re-index, OR `POST /api/vault/auto-ingest` mid-session.

Successfully ingested files move to `.processed/` under the same parent dir. Failures move to `.errored/` with a sibling `.error.txt` explaining why.

50 MB hard cap per file.

## False citation prevention

If no chunks score above the persona's `minConfidence` floor, zero context is injected into the system prompt. The model receives no instruction to fabricate sources. The citation block in the UI only appears when retrieval results exist.

Per-persona policy (`lib/personas.ts → Persona.retrieval`):

| Persona | defaultEnabled | topK | minConfidence |
|---|---|---|---|
| Bartimaeus | yes | 5 | medium |
| Sage | yes | 10 | low |
| Juniper | no (opt-in) | 3 | low |
| Bobby | no (opt-in) | 3 | low |

## See also

- [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md) — architecture deep-dive
- [`PHASE_3_INVENTORY.md`](PHASE_3_INVENTORY.md) — Phase 3 directive inventory + the embedding-model technical flag
- [`PHASE_3_REPORT.md`](PHASE_3_REPORT.md) — Phase 3-B validation results
- [`docs/AUDIT.md`](docs/AUDIT.md) — every vault event lands in the hash-chained audit log
