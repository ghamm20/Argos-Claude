// app/api/vault/auto-ingest/route.ts
//
// Phase 3 auto-ingest: scans $ARGOS_ROOT/vault/dropbox/ for files and
// ingests each via the existing vault pipeline. Files that succeed move
// to dropbox/.processed/. Files that fail move to dropbox/.errored/.
//
// Called by the launcher after [4/4] ARGOS ready — POST with no body.
// Idempotent: skips dirs starting with "." (so .processed/ + .errored/
// archives don't get re-scanned). Safe to call multiple times.
//
// Supports the same file types as upload route: .txt, .md, .pdf, .docx.

import { NextResponse } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { vaultRoot } from "@/lib/vault/paths";
import { ingest } from "@/lib/vault/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_EXT = new Set([".txt", ".md", ".pdf", ".docx"]);

interface IngestRecord {
  filename: string;
  status: "ingested" | "skipped" | "errored";
  docId?: string;
  chunkCount?: number;
  byteSize?: number;
  durationMs?: number;
  error?: string;
}

interface AutoIngestResult {
  dropboxPath: string;
  totalFiles: number;
  ingested: number;
  errored: number;
  skipped: number;
  records: IngestRecord[];
}

function dropboxDir(): string {
  return path.join(vaultRoot(), "dropbox");
}

function processedDir(): string {
  return path.join(dropboxDir(), ".processed");
}

function erroredDir(): string {
  return path.join(dropboxDir(), ".errored");
}

async function archive(srcFile: string, targetDir: string): Promise<string> {
  await fsp.mkdir(targetDir, { recursive: true });
  const base = path.basename(srcFile);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const targetPath = path.join(targetDir, `${ts}__${base}`);
  await fsp.rename(srcFile, targetPath);
  return targetPath;
}

export async function POST() {
  const dbx = dropboxDir();

  // Ensure dropbox/ exists — first-launch convenience.
  try {
    await fsp.mkdir(dbx, { recursive: true });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not create dropbox dir: ${String(e)}`, dropboxPath: dbx },
      { status: 500 }
    );
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(dbx, { withFileTypes: true });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read dropbox dir: ${String(e)}`, dropboxPath: dbx },
      { status: 500 }
    );
  }

  // Filter: files only (skip .processed/ + .errored/ + other dot-dirs),
  // and only supported extensions.
  const candidates = entries.filter((ent) => {
    if (!ent.isFile()) return false;
    if (ent.name.startsWith(".")) return false;
    const ext = path.extname(ent.name).toLowerCase();
    return SUPPORTED_EXT.has(ext);
  });

  const result: AutoIngestResult = {
    dropboxPath: dbx,
    totalFiles: candidates.length,
    ingested: 0,
    errored: 0,
    skipped: entries.length - candidates.length,
    records: [],
  };

  for (const ent of candidates) {
    const filePath = path.join(dbx, ent.name);
    try {
      const ingestResult = await ingest(filePath, { originalFilename: ent.name });
      await archive(filePath, processedDir());
      result.ingested++;
      result.records.push({
        filename: ent.name,
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
        await archive(filePath, erroredDir());
      } catch {
        /* if we can't even move it, leave for operator inspection */
      }
      result.errored++;
      result.records.push({
        filename: ent.name,
        status: "errored",
        error: msg.slice(0, 500),
      });
    }
  }

  return NextResponse.json(result);
}

// GET returns dropbox state without ingesting — useful for the launcher
// to "check if there's work" cheaply, or for the operator UI to preview.
export async function GET() {
  const dbx = dropboxDir();
  try {
    await fsp.mkdir(dbx, { recursive: true });
    const entries = await fsp.readdir(dbx, { withFileTypes: true });
    const pending = entries
      .filter(
        (ent) =>
          ent.isFile() &&
          !ent.name.startsWith(".") &&
          SUPPORTED_EXT.has(path.extname(ent.name).toLowerCase())
      )
      .map((ent) => ent.name);
    return NextResponse.json({
      dropboxPath: dbx,
      pending,
      pendingCount: pending.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e), dropboxPath: dbx },
      { status: 500 }
    );
  }
}
