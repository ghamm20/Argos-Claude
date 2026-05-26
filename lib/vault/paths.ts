import path from "node:path";

export function argosRoot(): string {
  return process.env.ARGOS_ROOT && process.env.ARGOS_ROOT.length > 0
    ? process.env.ARGOS_ROOT
    : process.cwd();
}

export function vaultRoot(): string {
  return path.join(argosRoot(), "vault");
}

export function docsDir(): string {
  return path.join(vaultRoot(), "docs");
}

export function indexDir(): string {
  return path.join(vaultRoot(), "index");
}

export function chunksDir(): string {
  return path.join(indexDir(), "chunks");
}

export function manifestPath(): string {
  return path.join(indexDir(), "manifest.json");
}

export function chunkFilePath(docId: string): string {
  return path.join(chunksDir(), `${docId}.json`);
}

export function storedDocPath(docId: string, filename: string): string {
  return path.join(docsDir(), `${docId}-${filename}`);
}

export function tmpUploadDir(): string {
  return path.join(docsDir(), ".tmp");
}

// Phase 3-B (2026-05-25): canonical operator drop-zone is now `vault/raw/`.
// `vault/dropbox/` is supported as a legacy fallback for back-compat with
// deployed payloads that already have a populated dropbox. Auto-ingest
// scans both. New code should prefer rawDir().
export function rawDir(): string {
  return path.join(vaultRoot(), "raw");
}

export function legacyDropboxDir(): string {
  return path.join(vaultRoot(), "dropbox");
}
