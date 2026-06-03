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

/** Audit a tool-call the parser could NOT execute (malformed JSON, unknown
 *  tool id, orphan tag). v2.3.8 doctrine: a tool-call ATTEMPT is never silently
 *  lost — every parse failure lands in the same append-only log as executions,
 *  tagged event:"parse_failed" with the raw text the model emitted. Best-effort. */
export async function appendParseFailureAudit(args: {
  raw: string;
  reason: string;
  toolId: string | null;
  sessionId: string | null;
  persona: string | null;
}): Promise<void> {
  await appendToolAudit({
    at: new Date().toISOString(),
    toolId: args.toolId ?? "(unparsed)",
    approved: null,
    ok: false,
    summary: "tool-call PARSE FAILED — model emitted a tool call the parser could not execute",
    error: args.reason,
    restorePointId: null,
    sessionId: args.sessionId,
    persona: args.persona,
    durationMs: 0,
    event: "parse_failed",
    rawText: args.raw.slice(0, 2000),
  });
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
    // Parse-failure entries are not executions — keep them out of per-tool
    // exec counts (they're still in the raw log for forensic review).
    if (e.event === "parse_failed") continue;
    const s = stats[e.toolId] ?? { count: 0, lastAt: null, lastOk: null };
    s.count += 1;
    // entries are appended chronologically; the last one wins.
    s.lastAt = e.at;
    s.lastOk = e.ok;
    stats[e.toolId] = s;
  }
  return stats;
}
