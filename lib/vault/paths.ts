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
