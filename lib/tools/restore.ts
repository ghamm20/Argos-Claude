// lib/tools/restore.ts
//
// Tools Phase (2026-06-02) — RESTORE points. Before any irreversible action
// (T15 delete, T16 shell), ARGOS snapshots the affected files/state into
// ARGOS_ROOT/restore/<id>/ with a manifest, BEFORE the tool runs. The operator
// can roll back via restoreFromPoint(id).

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import { restoreDir, restorePointDir } from "./paths";

export interface RestoreManifestFile {
  /** Absolute original path. */
  original: string;
  /** Path inside the restore point (relative to the point dir). */
  stored: string | null;
  /** Did the file exist at snapshot time? (deletes of new files = false) */
  existed: boolean;
  byteSize: number;
}

export interface RestoreManifest {
  id: string;
  toolId: string;
  createdAt: string;
  argosRoot: string;
  files: RestoreManifestFile[];
}

function tsId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  // 4-hex suffix guarantees uniqueness for two actions in the same second.
  return `${base}-${randomUUID().slice(0, 4)}`;
}

/**
 * Create a restore point snapshotting the given paths BEFORE a destructive
 * tool runs. Returns the restore point id. Best-effort but the caller treats a
 * null return as "snapshot failed → do not proceed with the irreversible op".
 */
export async function createRestorePoint(
  toolId: string,
  affectedPaths: string[]
): Promise<string | null> {
  try {
    const id = tsId();
    const dir = restorePointDir(id);
    const filesDir = path.join(dir, "files");
    await fsp.mkdir(filesDir, { recursive: true });

    const root = argosRoot();
    const files: RestoreManifestFile[] = [];
    for (const orig of affectedPaths) {
      const abs = path.resolve(orig);
      let existed = false;
      let byteSize = 0;
      let stored: string | null = null;
      if (existsSync(abs)) {
        try {
          const st = await fsp.stat(abs);
          if (st.isFile()) {
            // Mirror the file under files/, keyed by a flattened relative path.
            const rel = path.relative(root, abs).replace(/[\\/:]+/g, "__") || path.basename(abs);
            const dest = path.join(filesDir, rel);
            await fsp.copyFile(abs, dest);
            stored = path.join("files", rel);
            byteSize = st.size;
            existed = true;
          }
        } catch {
          /* unreadable — record as not-existed so restore won't recreate it */
        }
      }
      files.push({ original: abs, stored, existed, byteSize });
    }

    const manifest: RestoreManifest = {
      id,
      toolId,
      createdAt: new Date().toISOString(),
      argosRoot: root,
      files,
    };
    await fsp.writeFile(
      path.join(dir, "restore-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
    return id;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[tools/restore] createRestorePoint failed: ${(e as Error).message}`);
    return null;
  }
}

/** Roll a restore point back: copy each snapshotted file to its original path.
 *  Files that didn't exist at snapshot time are removed (they were created by
 *  the action being undone). Logs the restore. Never throws. */
export async function restoreFromPoint(
  restoreId: string
): Promise<{ ok: boolean; restored: number; reason: string }> {
  try {
    const dir = restorePointDir(restoreId);
    const manifestPath = path.join(dir, "restore-manifest.json");
    const raw = await fsp.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as RestoreManifest;
    let restored = 0;
    for (const f of manifest.files) {
      if (f.existed && f.stored) {
        await fsp.mkdir(path.dirname(f.original), { recursive: true });
        await fsp.copyFile(path.join(dir, f.stored), f.original);
        restored++;
      } else if (!f.existed) {
        // File was created by the undone action → remove it.
        await fsp.rm(f.original, { force: true });
        restored++;
      }
    }
    // Append a restore marker into the point dir for forensics.
    await fsp.appendFile(
      path.join(dir, "restore-log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), restored }) + "\n",
      "utf8"
    );
    return { ok: true, restored, reason: "restored" };
  } catch (e) {
    return { ok: false, restored: 0, reason: (e as Error).message };
  }
}

export async function listRestorePoints(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(restoreDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  } catch {
    return [];
  }
}
