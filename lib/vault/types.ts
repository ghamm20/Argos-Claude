export interface DocumentMeta {
  id: string;
  filename: string;
  ingestedAt: number;
  chunkCount: number;
  sha256: string;
  byteSize: number;
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
 */
export type Confidence = "high" | "medium" | "low";

export const CONFIDENCE_THRESHOLDS = {
  high: 0.55,
  medium: 0.40,
  low: 0.25,
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
