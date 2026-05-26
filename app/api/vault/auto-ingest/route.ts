// app/api/vault/auto-ingest/route.ts
//
// Phase 3 auto-ingest: scans the operator drop-zone(s) and ingests each
// file via the existing vault pipeline. Files that succeed move to
// `.processed/`. Files that fail move to `.errored/`.
//
// Phase 3-B (2026-05-25) update: scans BOTH `vault/raw/` (canonical
// going forward per directive) AND `vault/dropbox/` (legacy back-compat).
// Operators can migrate at their own pace; either folder works.
//
// Called by the launcher after [4/4] ARGOS ready — POST with no body.
// Idempotent: skips dirs starting with "." (so .processed/ + .errored/
// archives don't get re-scanned). Safe to call multiple times.
//
// Supports the same file types as upload route: .txt, .md, .pdf, .docx.

import { NextResponse } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { rawDir, legacyDropboxDir } from "@/lib/vault/paths";
import { ingest } from "@/lib/vault/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_EXT = new Set([".txt", ".md", ".pdf", ".docx"]);

interface IngestRecord {
  filename: string;
  dropZone: string; // "raw" | "dropbox"
  status: "ingested" | "skipped" | "errored";
  docId?: string;
  chunkCount?: number;
  byteSize?: number;
  durationMs?: number;
  error?: string;
}

interface AutoIngestResult {
  rawPath: string;
  legacyDropboxPath: string;
  totalFiles: number;
  ingested: number;
  errored: number;
  skipped: number;
  records: IngestRecord[];
}

function processedDir(parentDir: string): string {
  return path.join(parentDir, ".processed");
}

function erroredDir(parentDir: string): string {
  return path.join(parentDir, ".errored");
}

async function archive(srcFile: string, targetDir: string): Promise<string> {
  await fsp.mkdir(targetDir, { recursive: true });
  const base = path.basename(srcFile);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const targetPath = path.join(targetDir, `${ts}__${base}`);
  await fsp.rename(srcFile, targetPath);
  return targetPath;
}

/**
 * Read candidates from one drop-zone. Returns [] (not error) if the
 * directory doesn't exist — legacy `dropbox/` may simply not be present
 * on a fresh install.
 */
async function readDropZoneCandidates(dir: string): Promise<string[]> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((ent) => {
        if (!ent.isFile()) return false;
        if (ent.name.startsWith(".")) return false;
        const ext = path.extname(ent.name).toLowerCase();
        return SUPPORTED_EXT.has(ext);
      })
      .map((ent) => ent.name);
  } catch {
    return [];
  }
}

async function processDropZone(
  dir: string,
  zoneLabel: string,
  result: AutoIngestResult
): Promise<void> {
  const names = await readDropZoneCandidates(dir);
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const ingestResult = await ingest(filePath, { originalFilename: name });
      await archive(filePath, processedDir(dir));
      result.ingested++;
      result.records.push({
        filename: name,
        dropZone: zoneLabel,
        status: "ingested",
        docId: ingestResult.docId,
        chunkCount: ingestResult.chunkCount,
        byteSize: ingestResult.byteSize,
        durationMs: Math.round(ingestResult.durationMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Try to move to errored/ even on failure so the next run doesn't
      // retry-loop on the same broken file.
      try {
        await archive(filePath, erroredDir(dir));
      } catch {
        /* if we can't even move it, leave for operator inspection */
      }
      result.errored++;
      result.records.push({
        filename: name,
        dropZone: zoneLabel,
        status: "errored",
        error: msg.slice(0, 500),
      });
    }
  }
  result.totalFiles += names.length;
}

export async function POST() {
  const raw = rawDir();
  const dbx = legacyDropboxDir();

  const result: AutoIngestResult = {
    rawPath: raw,
    legacyDropboxPath: dbx,
    totalFiles: 0,
    ingested: 0,
    errored: 0,
    skipped: 0,
    records: [],
  };

  // Phase 3-B order: raw/ first (canonical), then dropbox/ (legacy).
  // If both have the same filename, raw/ wins because it's processed first.
  await processDropZone(raw, "raw", result);
  await processDropZone(dbx, "dropbox", result);

  return NextResponse.json(result);
}

// GET returns drop-zone state without ingesting — useful for the launcher
// to "check if there's work" cheaply, or for the operator UI to preview.
export async function GET() {
  const raw = rawDir();
  const dbx = legacyDropboxDir();
  const rawPending = await readDropZoneCandidates(raw);
  const dbxPending = await readDropZoneCandidates(dbx);
  return NextResponse.json({
    rawPath: raw,
    legacyDropboxPath: dbx,
    pending: {
      raw: rawPending,
      dropbox: dbxPending,
    },
    pendingCount: rawPending.length + dbxPending.length,
  });
}
