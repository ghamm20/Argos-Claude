// lib/loops/backup.ts
//
// Self-Evolving Loop Suite — all-night doctrine (2026-06-02).
//
// "Backup before any major write — no exceptions." Every file-modifying loop
// snapshots the files it is about to touch into ARGOS_ROOT/restore/loops/<id>/
// BEFORE the write. If the post-write test fails, rollbackLoopBackup() restores
// the exact bytes. Backups are never deleted automatically — they are the
// operator's morning safety net.
//
// This mirrors lib/tools/restore.ts but lives under restore/loops/ and carries
// the loopId + reason in the manifest so the morning review reads cleanly.

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";

export function loopsRestoreDir(): string {
  return path.join(argosRoot(), "restore", "loops");
}
export function loopBackupDir(id: string): string {
  return path.join(loopsRestoreDir(), id);
}

export interface LoopBackupFile {
  /** Absolute original path. */
  original: string;
  /** Path inside the backup (relative to the backup dir), or null if absent. */
  stored: string | null;
  /** Did the file exist at snapshot time? (a created file = false → rollback removes it) */
  existed: boolean;
  byteSize: number;
}

export interface LoopBackupManifest {
  id: string;
  loopId: string;
  reason: string;
  createdAt: string;
  argosRoot: string;
  files: LoopBackupFile[];
}

function tsId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours()
  )}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `${base}-${randomUUID().slice(0, 4)}`;
}

/**
 * Snapshot the given paths BEFORE a loop modifies them. Returns the backup id,
 * or null if the snapshot failed (the caller MUST treat null as "do not write").
 * Never throws.
 */
export async function createLoopBackup(
  loopId: string,
  reason: string,
  affectedPaths: string[]
): Promise<string | null> {
  try {
    const id = tsId();
    const dir = loopBackupDir(id);
    const filesDir = path.join(dir, "files");
    await fsp.mkdir(filesDir, { recursive: true });

    const root = argosRoot();
    const files: LoopBackupFile[] = [];
    for (const orig of affectedPaths) {
      const abs = path.resolve(orig);
      let existed = false;
      let byteSize = 0;
      let stored: string | null = null;
      if (existsSync(abs)) {
        try {
          const st = await fsp.stat(abs);
          if (st.isFile()) {
            const rel = path.relative(root, abs).replace(/[\\/:]+/g, "__") || path.basename(abs);
            const dest = path.join(filesDir, rel);
            await fsp.copyFile(abs, dest);
            stored = path.join("files", rel);
            byteSize = st.size;
            existed = true;
          }
        } catch {
          /* unreadable — record as not-existed so rollback won't recreate it */
        }
      }
      files.push({ original: abs, stored, existed, byteSize });
    }

    const manifest: LoopBackupManifest = {
      id,
      loopId,
      reason,
      createdAt: new Date().toISOString(),
      argosRoot: root,
      files,
    };
    await fsp.writeFile(
      path.join(dir, "backup-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
    return id;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[loops/backup] createLoopBackup failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Roll a backup back: restore each snapshotted file to its original path. Files
 * that did not exist at snapshot time are removed (they were created by the
 * undone change). Appends a rollback marker. Never throws.
 */
export async function rollbackLoopBackup(
  id: string
): Promise<{ ok: boolean; restored: number; reason: string }> {
  try {
    const dir = loopBackupDir(id);
    const raw = await fsp.readFile(path.join(dir, "backup-manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as LoopBackupManifest;
    let restored = 0;
    for (const f of manifest.files) {
      if (f.existed && f.stored) {
        await fsp.mkdir(path.dirname(f.original), { recursive: true });
        await fsp.copyFile(path.join(dir, f.stored), f.original);
        restored++;
      } else if (!f.existed) {
        await fsp.rm(f.original, { force: true });
        restored++;
      }
    }
    await fsp.appendFile(
      path.join(dir, "rollback-log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), restored }) + "\n",
      "utf8"
    );
    return { ok: true, restored, reason: "restored" };
  } catch (e) {
    return { ok: false, restored: 0, reason: (e as Error).message };
  }
}

export async function getLoopBackup(id: string): Promise<LoopBackupManifest | null> {
  try {
    const raw = await fsp.readFile(path.join(loopBackupDir(id), "backup-manifest.json"), "utf8");
    return JSON.parse(raw) as LoopBackupManifest;
  } catch {
    return null;
  }
}

/** All backups, most-recent first (ids sort lexically by timestamp). */
export async function listLoopBackups(limit = 100): Promise<LoopBackupManifest[]> {
  let ids: string[] = [];
  try {
    const entries = await fsp.readdir(loopsRestoreDir(), { withFileTypes: true });
    ids = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out: LoopBackupManifest[] = [];
  for (const id of ids.slice(0, limit)) {
    const m = await getLoopBackup(id);
    if (m) out.push(m);
  }
  return out;
}
