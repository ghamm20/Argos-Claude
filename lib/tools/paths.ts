// lib/tools/paths.ts
//
// Tools Phase (2026-06-02) — filesystem locations for the tool suite, all
// derived from argosRoot() so they travel with the USB payload and obey the
// Seven USB-Native Rules (no hardcoded absolute paths).

import path from "node:path";
import { argosRoot } from "../vault/paths";

/** Generated documents / drafts / reports land here. */
export function outputDir(): string {
  return path.join(argosRoot(), "output");
}

/** Restore points: restore/YYYY-MM-DD-HH-MM-SS/ snapshots. */
export function restoreDir(): string {
  return path.join(argosRoot(), "restore");
}

export function restorePointDir(id: string): string {
  return path.join(restoreDir(), id);
}

/** Append-only tool execution audit log. */
export function toolAuditPath(): string {
  return path.join(argosRoot(), "state", "tool-audit.jsonl");
}

/** Optional schedule data drop-zone for T11 (guard schedule query). */
export function scheduleDataDir(): string {
  return path.join(argosRoot(), "data", "schedule");
}

/** The hard file-system boundary for T15 — nothing outside argosRoot(). */
export function argosBoundary(): string {
  return argosRoot();
}
