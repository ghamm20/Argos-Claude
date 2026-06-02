export interface DocumentMeta {
  id: string;
  filename: string;
  ingestedAt: number;
  chunkCount: number;
  sha256: string;
  byteSize: number;
  // Vision Phase 1 (2026-06-02) — file-vision fields. Optional + back-compat:
  // existing text documents simply omit them (kind defaults to "text").
  /** "text" (default) or "image" (ingested via vision description). */
  kind?: "text" | "image";
  /** For images: the gemma4-turbo vision description that was chunked +
   *  embedded as this doc's searchable text. */
  description?: string;
  /** For images: a small data-URL thumbnail for display. Null when the
   *  original is too large to inline without a resize dependency. */
  thumb?: string | null;
}

export interface ChunkMetadata {
  docId: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
}

export interface Chunk {
  chunkId: string;
  text: string;
  embedding: number[];
  metadata: ChunkMetadata;
}

export interface ChunksFile {
  version: number;
  chunks: Chunk[];
}

export interface Manifest {
  version: number;
  documents: DocumentMeta[];
}

export interface IngestResult {
  docId: string;
  filename: string;
  chunkCount: number;
  byteSize: number;
  durationMs: number;
  embeddingDurationMs: number;
}

export type IngestStage =
  | "uploading"
  | "extracting"
  | "chunking"
  | "embedding"
  | "done"
  | "error";

export interface IngestProgress {
  stage: IngestStage;
  current?: number;
  total?: number;
  result?: IngestResult;
  error?: string;
}

/**
 * Phase 3 confidence buckets for retrieval hits.
 * Thresholds calibrated to nomic-embed-text cosine score distribution.
 * See docs/RETRIEVAL.md for derivation + how to tune.
 *
 * Phase 3-B (2026-05-25) recalibration based on EKG seed corpus Q5
 * false-citation evidence: raised the drop floor from 0.25 → 0.50
 * because nomic-embed-text returns 0.45-0.50 cosine on ANY pair of
 * English text regardless of topical relevance (it learns general
 * English structure). Below 0.50 is background noise on this model.
 *
 * Observed thresholds on the EKG validation corpus:
 *   - True topical matches:    0.566-0.814  → HIGH or upper-MEDIUM
 *   - Background noise floor:  0.450-0.500  → drop (was MEDIUM/LOW pre-cal)
 *   - Q5 ("boiling point of water") returned 5 hits at 0.459-0.475 —
 *     all dropped at the new 0.50 floor → false-citation rate 0/5.
 *
 * See PHASE_3_REPORT.md §validation for the data.
 */
export type Confidence = "high" | "medium" | "low";

export const CONFIDENCE_THRESHOLDS = {
  high: 0.60,
  medium: 0.50,
  low: 0.50, // collapsed — no useful "weak" zone above the noise floor
  // hits scoring below `low` are filtered out before returning.
} as const;

export function scoreToConfidence(score: number): Confidence | null {
  if (score >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (score >= CONFIDENCE_THRESHOLDS.medium) return "medium";
  if (score >= CONFIDENCE_THRESHOLDS.low) return "low";
  return null;
}

export interface RetrievalHit {
  chunkId: string;
  text: string;
  score: number;
  /** Phase 3: bucketed confidence. null only if explicitly disabled; the
   *  store's retrieve() filters below-low hits before returning. */
  confidence: Confidence;
  docId: string;
  filename: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
}
