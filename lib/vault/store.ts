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
import { chunkText, pickChunkOpts } from "./chunk";
import { embedText } from "./embed";
import { appendAudit, readChain } from "../audit";
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
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Phase 8 vault-integrity fix (2026-06-10): a MISSING manifest with
      // chunk files still on disk is the silent-loss case — the vault would
      // report empty while every document sits orphaned. Rebuild from the
      // chunks instead of silently returning empty.
      return recoverManifestIfChunksExist("manifest missing (ENOENT)");
    }
    throw e;
  }
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    // Truncated / corrupt manifest (e.g. a USB yank mid-write before the
    // atomic-write fix below, or external damage). The chunks are the source
    // of truth — rebuild rather than throw or report empty.
    return recoverManifestIfChunksExist("manifest unparseable (corrupt/truncated)");
  }
}

/** Phase 8 vault-integrity (2026-06-10) — THE SELF-HEAL. A vault must never
 *  silently lose files: the chunk files (and stored originals) are the source
 *  of truth, the manifest is a derived index. When the manifest is missing or
 *  corrupt, rebuild it from the orphaned chunks on disk, persist it atomically,
 *  and audit the recovery (never silent). Returns an empty manifest only when
 *  there genuinely are no chunks. */
async function recoverManifestIfChunksExist(reason: string): Promise<Manifest> {
  let chunkNames: string[] = [];
  try {
    chunkNames = (await fsp.readdir(chunksDir())).filter((n) => n.endsWith(".json"));
  } catch {
    chunkNames = [];
  }
  if (chunkNames.length === 0) {
    return { version: MANIFEST_VERSION, documents: [] };
  }

  // ---- Phase 9 rider (2026-06-10): the SELF-HEAL TRUST BOUNDARY ----
  // The manifest rebuilds from whatever chunk files are on disk — so a PLANTED
  // chunk would become canon after a heal. Anchor trust in the hash-chained
  // audit log (which survives manifest loss + is tamper-evident): build the
  // provenance map docId → recorded chunkSha256 from vault.ingested entries.
  //   - chunk WITH a recorded hash that MATCHES   → recognized, indexed.
  //   - chunk WITH a recorded hash that MISMATCHES → TAMPERED → quarantined.
  //   - chunk with a vault.ingested entry but NO recorded hash (legacy ingest,
  //       pre-rider) → recognized (can't verify; existence-of-provenance
  //       trusted), indexed.
  //   - chunk with NO vault.ingested entry at all → PLANTED → quarantined,
  //       UNLESS there is zero provenance in the whole chain (a copied vault
  //       with no state/ — then fall back to legacy trust + a heal_unverified
  //       audit, so a provenance-less copy isn't wholesale quarantined).
  // Quarantined chunks are MOVED to vault/index/quarantine/ and audited; they
  // are NEVER silently indexed.
  const provenance = new Map<string, { ingested: boolean; chunkSha256: string | null }>();
  try {
    for (const e of await readChain()) {
      if (e.kind !== "vault.ingested") continue;
      const p = e.payload as { docId?: string; chunkSha256?: string };
      if (typeof p.docId === "string") {
        provenance.set(p.docId, { ingested: true, chunkSha256: typeof p.chunkSha256 === "string" ? p.chunkSha256 : null });
      }
    }
  } catch {
    /* no audit chain — provenance stays empty (handled below) */
  }
  const hasAnyProvenance = provenance.size > 0;
  const quarantineDir = path.join(indexDir(), "quarantine");

  // Map docs/ originals (<docId>-<filename>) for filename + byteSize recovery.
  let docEntries: string[] = [];
  try {
    docEntries = await fsp.readdir(docsDir());
  } catch {
    docEntries = [];
  }
  const documents: DocumentMeta[] = [];
  const quarantined: Array<{ docId: string; why: string }> = [];
  let healUnverified = false;
  for (const cn of chunkNames) {
    const docId = cn.replace(/\.json$/, "");
    const chunkPath = path.join(chunksDir(), cn);
    try {
      const rawChunk = await fsp.readFile(chunkPath, "utf8");
      const cf = JSON.parse(rawChunk) as ChunksFile;
      const chunkCount = Array.isArray(cf.chunks) ? cf.chunks.length : 0;
      if (chunkCount === 0) continue;

      // ---- trust check ----
      const prov = provenance.get(docId);
      const actualHash = sha256OfBuffer(Buffer.from(rawChunk, "utf8"));
      let trusted = true;
      let quarantineWhy = "";
      if (!hasAnyProvenance) {
        // Provenance-less vault (e.g. copied without state/). Legacy trust.
        trusted = true;
        healUnverified = true;
      } else if (!prov) {
        trusted = false;
        quarantineWhy = "no vault.ingested provenance for this docId (planted/unknown chunk)";
      } else if (prov.chunkSha256 && prov.chunkSha256 !== actualHash) {
        trusted = false;
        quarantineWhy = `chunk sha256 mismatch (recorded ${prov.chunkSha256.slice(0, 12)}…, on-disk ${actualHash.slice(0, 12)}…) — tampered`;
      }
      if (!trusted) {
        // Quarantine: move out of chunks/ so retrieval can never reach it.
        try {
          await fsp.mkdir(quarantineDir, { recursive: true });
          await fsp.rename(chunkPath, path.join(quarantineDir, cn));
        } catch {
          /* best-effort move; if it fails the chunk simply isn't indexed below */
        }
        quarantined.push({ docId, why: quarantineWhy });
        continue;
      }

      const origName = docEntries.find((d) => d.startsWith(`${docId}-`));
      const filename = origName ? origName.slice(docId.length + 1) : `${docId}.recovered`;
      let byteSize = 0;
      let sha256 = "";
      if (origName) {
        try {
          const buf = await fsp.readFile(path.join(docsDir(), origName));
          byteSize = buf.length;
          sha256 = sha256OfBuffer(buf);
        } catch {
          /* original gone — chunks still retrievable; meta best-effort */
        }
      }
      let ingestedAt = Date.now();
      try {
        ingestedAt = (await fsp.stat(chunkPath)).mtimeMs;
      } catch {
        /* keep now() */
      }
      documents.push({ id: docId, filename, ingestedAt, chunkCount, sha256, byteSize });
    } catch {
      /* skip an unreadable chunk file — recover the rest */
    }
  }
  const rebuilt: Manifest = { version: MANIFEST_VERSION, documents };
  // Persist the rebuilt manifest atomically so the recovery is durable.
  await writeManifest(rebuilt).catch(() => {});
  await appendAudit("vault.manifest_recovered", {
    reason,
    recoveredDocs: documents.length,
    docIds: documents.map((d) => d.id),
    quarantinedCount: quarantined.length,
    provenanceVerified: hasAnyProvenance && !healUnverified,
  }).catch(() => {});
  for (const q of quarantined) {
    await appendAudit("vault.chunk_quarantined", { docId: q.docId, reason: q.why }).catch(() => {});
  }
  if (healUnverified) {
    await appendAudit("vault.heal_unverified", {
      reason: "no audit provenance available — chunks indexed on operator-local-disk trust (no hash verification possible)",
      indexedDocs: documents.length,
    }).catch(() => {});
  }
  // eslint-disable-next-line no-console
  console.warn(`[vault] manifest recovered from chunks (${reason}): ${documents.length} restored, ${quarantined.length} quarantined`);
  return rebuilt;
}

async function writeManifest(m: Manifest): Promise<void> {
  await ensureDirs();
  // Phase 8 vault-integrity fix (2026-06-10): ATOMIC write. The old plain
  // fsp.writeFile truncates-then-writes, so a USB yank or crash mid-write left
  // a 0-byte/partial manifest — the silent-loss root cause. Write to a per-pid
  // temp file, fsync, then rename over the target (same posture as settings.ts
  // and the audit chain). A yank mid-write leaves either the previous valid
  // manifest or the new one — never a corrupt one.
  const finalPath = manifestPath();
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const payload = JSON.stringify(m, null, 2);
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(payload, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmpPath, finalPath);
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
  /** Vision Phase 1 — when set, skip text extraction and chunk/embed this
   *  text instead. Used by file-vision: the image's vision description IS
   *  the searchable text. The original image bytes are still stored. */
  precomputedText?: string;
  /** Vision Phase 1 — extra DocumentMeta fields (kind/description/thumb)
   *  merged into the manifest entry. */
  extraMeta?: Pick<DocumentMeta, "kind" | "description" | "thumb">;
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
  // Vision Phase 1: file-vision passes the image's vision description as
  // precomputedText so we skip extractText (which rejects image types) and
  // make the description searchable through the normal chunk/embed pipeline.
  const text =
    opts.precomputedText !== undefined
      ? opts.precomputedText
      : await extractText(filepath);

  opts.onProgress?.({ stage: "chunking" });
  // Vault long-form fix (2026-05-28): big PDFs (≥500KB) get the
  // 1200/200 prose-tolerant preset so character-name retrieval
  // doesn't drown in surrounding narrative. Smaller docs keep the
  // default 512/51. See pickChunkOpts in chunk.ts for the heuristic.
  const chunkOpts = pickChunkOpts(buf.length);
  const rawChunks = chunkText(text, chunkOpts);

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

  // Persist chunks JSON. Phase 9 rider (2026-06-10) — record the sha256 of the
  // chunk-file bytes so the self-heal can VERIFY a chunk at recovery time (see
  // recoverManifestIfChunksExist). The hash is anchored in the hash-chained
  // audit log (survives manifest loss, tamper-evident).
  const chunksFile: ChunksFile = { version: CHUNKS_VERSION, chunks };
  const chunksJson = JSON.stringify(chunksFile);
  const chunkSha256 = sha256OfBuffer(Buffer.from(chunksJson, "utf8"));
  await fsp.writeFile(
    chunkFilePath(docId),
    chunksJson,
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
    // Vision Phase 1 — image docs carry kind/description/thumb.
    ...(opts.extraMeta ?? {}),
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
      chunkSha256, // Phase 9 rider — chunk-file integrity anchor for self-heal.
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

// Phase 8 (2026-06-10) — canon-corpus presence. The Bartimaeus canon-name
// suppression (Option E) exists because the vault USED to mislead the model on
// canon characters when it held no canon. Once the Stroud trilogy is indexed,
// that rationale inverts: canon queries SHOULD retrieve from the authoritative
// corpus. This lets the orchestrator suppress only when the corpus is absent.
const CANON_FILENAME_RE = /amulet|golem|ptolemy|plotemy|samarkand|bartimaeus|stroud/i;
let canonCorpusCache: { at: number; present: boolean } | null = null;

export async function canonCorpusIndexed(): Promise<boolean> {
  // 30s cache — this is consulted on every Bartimaeus canon-name turn; the
  // corpus changes only on ingest/delete (rare relative to chat).
  const now = Date.now();
  if (canonCorpusCache && now - canonCorpusCache.at < 30_000) return canonCorpusCache.present;
  let present = false;
  try {
    const manifest = await readManifest();
    present = manifest.documents.some((d) => CANON_FILENAME_RE.test(d.filename ?? ""));
  } catch {
    present = false;
  }
  canonCorpusCache = { at: now, present };
  return present;
}

/**
 * Re-chunk + re-embed an already-ingested document, without requiring
 * the operator to re-upload the file. Reads the stored original from
 * the vault's docs/ tree, re-runs the full ingest pipeline against
 * it, and overwrites the chunks file + manifest entry in place.
 *
 * Why this exists: the long-form chunking heuristic (Vault fix
 * 2026-05-28) only fires on FRESH ingests. Documents already in the
 * vault from before the fix still carry their original (smaller)
 * chunks and won't benefit until re-chunked. Rather than make the
 * operator re-upload, this function lets them refresh in place.
 *
 * Identity preservation: because docId is derived from the file's
 * sha256, re-ingesting the same bytes produces the same docId. The
 * manifest entry is filtered-by-id-then-pushed in ingest(), so the
 * net effect is "replace entry with same id". Old chunks file is
 * overwritten via fs.writeFile.
 *
 * Returns the IngestResult exactly as ingest() does, so callers can
 * report chunk-count deltas.
 */
export async function reingestDocument(
  docId: string,
  onProgress?: (p: IngestProgress) => void
): Promise<IngestResult> {
  const manifest = await readManifest();
  const doc = manifest.documents.find((d) => d.id === docId);
  if (!doc) {
    throw new Error(`reingest: no document with docId=${docId}`);
  }
  const storedPath = storedDocPath(docId, doc.filename);
  // Verify the stored original is still present — manifest can
  // outlive disk in pathological cases (manual rm).
  try {
    await fsp.access(storedPath);
  } catch {
    throw new Error(
      `reingest: stored file missing at ${storedPath} (manifest references it but disk does not)`
    );
  }
  // Delegate to the normal ingest path. Same docId because same
  // bytes → same sha256. ingest() also writes audit + manifest +
  // emits progress events.
  return ingest(storedPath, {
    originalFilename: doc.filename,
    onProgress,
  });
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
