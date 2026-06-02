// lib/tools/audit.ts
//
// Tools Phase (2026-06-02) — append-only tool execution audit log at
// ARGOS_ROOT/state/tool-audit.jsonl. One JSON object per line. Never deleted,
// never overwritten. Reads power the Tools-page status (exec count + last use).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { toolAuditPath } from "./paths";
import type { ToolAuditEntry } from "./types";

/** Append one audit entry. Best-effort: never throws (audit failure must not
 *  break tool execution). */
export async function appendToolAudit(entry: ToolAuditEntry): Promise<void> {
  try {
    const p = toolAuditPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[tools/audit] append failed (non-fatal): ${(e as Error).message}`);
  }
}

export async function readToolAudit(): Promise<ToolAuditEntry[]> {
  try {
    const raw = await fsp.readFile(toolAuditPath(), "utf8");
    const out: ToolAuditEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as ToolAuditEntry);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ToolStat {
  count: number;
  lastAt: string | null;
  lastOk: boolean | null;
}

/** Per-tool execution stats derived from the audit log. */
export async function toolStats(): Promise<Record<string, ToolStat>> {
  const entries = await readToolAudit();
  const stats: Record<string, ToolStat> = {};
  for (const e of entries) {
    const s = stats[e.toolId] ?? { count: 0, lastAt: null, lastOk: null };
    s.count += 1;
    // entries are appended chronologically; the last one wins.
    s.lastAt = e.at;
    s.lastOk = e.ok;
    stats[e.toolId] = s;
  }
  return stats;
}
