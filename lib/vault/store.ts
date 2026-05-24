import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  argosRoot,
  chunkFilePath,
  chunksDir,
  docsDir,
  indexDir,
  manifestPath,
  storedDocPath,
  vaultRoot,
} from "./paths";
import { extractText } from "./extract";
import { chunkText } from "./chunk";
import { embedText } from "./embed";
import { appendAudit } from "../audit";
import type {
  Chunk,
  ChunksFile,
  Confidence,
  DocumentMeta,
  IngestProgress,
  IngestResult,
  Manifest,
  RetrievalHit,
} from "./types";
import { CONFIDENCE_THRESHOLDS, scoreToConfidence } from "./types";

const MANIFEST_VERSION = 1;
const CHUNKS_VERSION = 1;

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(argosRoot(), { recursive: true });
  await fsp.mkdir(vaultRoot(), { recursive: true });
  await fsp.mkdir(docsDir(), { recursive: true });
  await fsp.mkdir(indexDir(), { recursive: true });
  await fsp.mkdir(chunksDir(), { recursive: true });
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await fsp.readFile(manifestPath(), "utf8");
    return JSON.parse(raw) as Manifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: MANIFEST_VERSION, documents: [] };
    }
    throw e;
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  await ensureDirs();
  await fsp.writeFile(manifestPath(), JSON.stringify(m, null, 2), "utf8");
}

function sha256OfBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface IngestOpts {
  onProgress?: (p: IngestProgress) => void;
  originalFilename?: string;
}

export async function ingest(
  filepath: string,
  opts: IngestOpts = {}
): Promise<IngestResult> {
  const totalStart = performance.now();
  await ensureDirs();

  const buf = await fsp.readFile(filepath);
  const sha256 = sha256OfBuffer(buf);
  const docId = sha256.slice(0, 16);
  const filename = opts.originalFilename ?? path.basename(filepath);

  opts.onProgress?.({ stage: "extracting" });
  const text = await extractText(filepath);

  opts.onProgress?.({ stage: "chunking" });
  const rawChunks = chunkText(text);

  if (rawChunks.length === 0) {
    throw new Error(
      `no extractable content in ${filename} — empty after chunking`
    );
  }

  const embedStart = performance.now();
  const chunks: Chunk[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    opts.onProgress?.({
      stage: "embedding",
      current: i + 1,
      total: rawChunks.length,
    });
    const embedding = await embedText(rawChunks[i].text);
    chunks.push({
      chunkId: `${docId}-${i}`,
      text: rawChunks[i].text,
      embedding,
      metadata: {
        docId,
        chunkIndex: i,
        charStart: rawChunks[i].charStart,
        charEnd: rawChunks[i].charEnd,
      },
    });
  }
  const embeddingDurationMs = performance.now() - embedStart;

  // Persist chunks JSON
  const chunksFile: ChunksFile = { version: CHUNKS_VERSION, chunks };
  await fsp.writeFile(
    chunkFilePath(docId),
    JSON.stringify(chunksFile),
    "utf8"
  );

  // Persist original
  await fsp.writeFile(storedDocPath(docId, filename), buf);

  // Update manifest (dedup by docId)
  const meta: DocumentMeta = {
    id: docId,
    filename,
    ingestedAt: Date.now(),
    chunkCount: chunks.length,
    sha256,
    byteSize: buf.length,
  };
  const manifest = await readManifest();
  manifest.documents = manifest.documents.filter((d) => d.id !== docId);
  manifest.documents.push(meta);
  await writeManifest(manifest);

  const result: IngestResult = {
    docId,
    filename,
    chunkCount: chunks.length,
    byteSize: buf.length,
    durationMs: performance.now() - totalStart,
    embeddingDurationMs,
  };
  opts.onProgress?.({ stage: "done", result });

  // Phase 4 audit: record ingest event. Best-effort; never breaks ingest.
  try {
    await appendAudit("vault.ingested", {
      docId,
      filename,
      sha256,
      byteSize: buf.length,
      chunkCount: chunks.length,
      durationMs: Math.round(result.durationMs),
    });
  } catch (auditErr) {
    console.warn(
      `[vault] audit append failed (non-fatal): ${(auditErr as Error).message}`
    );
  }

  return result;
}

export async function listDocuments(): Promise<DocumentMeta[]> {
  const manifest = await readManifest();
  return [...manifest.documents].sort((a, b) => b.ingestedAt - a.ingestedAt);
}

export async function deleteDocument(docId: string): Promise<boolean> {
  const manifest = await readManifest();
  const doc = manifest.documents.find((d) => d.id === docId);
  if (!doc) return false;

  for (const target of [
    chunkFilePath(docId),
    storedDocPath(docId, doc.filename),
  ]) {
    try {
      await fsp.unlink(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  manifest.documents = manifest.documents.filter((d) => d.id !== docId);
  await writeManifest(manifest);

  // Phase 4 audit: record delete. Best-effort.
  try {
    await appendAudit("vault.deleted", {
      docId,
      filename: doc.filename,
      chunkCount: doc.chunkCount,
    });
  } catch (auditErr) {
    console.warn(
      `[vault] audit append failed (non-fatal): ${(auditErr as Error).message}`
    );
  }

  return true;
}

export async function totalChunkCount(): Promise<number> {
  const docs = await listDocuments();
  return docs.reduce((sum, d) => sum + d.chunkCount, 0);
}

export interface RetrieveOpts {
  /** Floor confidence — hits below this bucket are filtered out.
   *  Default "low" (= CONFIDENCE_THRESHOLDS.low, ≈ 0.25). Set "medium"
   *  for verification-style personas, "low" for research-style. */
  minConfidence?: Confidence;
}

export async function retrieve(
  query: string,
  topK = 5,
  opts: RetrieveOpts = {}
): Promise<RetrievalHit[]> {
  const minConf: Confidence = opts.minConfidence ?? "low";
  const floor = CONFIDENCE_THRESHOLDS[minConf];

  const qvec = await embedText(query);
  const manifest = await readManifest();

  const hits: RetrievalHit[] = [];
  for (const doc of manifest.documents) {
    let chunksFile: ChunksFile;
    try {
      const raw = await fsp.readFile(chunkFilePath(doc.id), "utf8");
      chunksFile = JSON.parse(raw) as ChunksFile;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const ch of chunksFile.chunks) {
      const score = cosine(qvec, ch.embedding);
      // Filter below-floor hits cheaply BEFORE allocating the hit object.
      if (score < floor) continue;
      const conf = scoreToConfidence(score);
      // scoreToConfidence returns null only when score < CONFIDENCE_THRESHOLDS.low;
      // we already filtered by floor (which is >= that) so conf is non-null.
      if (!conf) continue;
      hits.push({
        chunkId: ch.chunkId,
        text: ch.text,
        score,
        confidence: conf,
        docId: ch.metadata.docId,
        filename: doc.filename,
        chunkIndex: ch.metadata.chunkIndex,
        charStart: ch.metadata.charStart,
        charEnd: ch.metadata.charEnd,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
