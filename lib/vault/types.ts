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

export interface RetrievalHit {
  chunkId: string;
  text: string;
  score: number;
  docId: string;
  filename: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
}
