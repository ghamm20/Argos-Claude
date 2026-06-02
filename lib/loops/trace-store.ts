// lib/loops/trace-store.ts
//
// Self-Evolving Loop Suite (2026-06-02) — the append-only trace store.
//
// Every loop run is recorded here. Traces are NEVER deleted or mutated — this
// is the audit trail of the system improving (or trying to and being stopped).
// One JSONL file per loop: state/loops/<loopId>-traces.jsonl. Writes are
// append-only (fsp.appendFile); there is deliberately no delete/clear export.
//
// Server-only (node fs).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import type { LoopId, LoopTrace } from "./types";

/** state/loops/ — the trace directory. */
export function loopsStateDir(): string {
  return path.join(argosRoot(), "state", "loops");
}

/** state/loops/<loopId>-traces.jsonl — one append-only file per loop. */
export function loopTracePath(loopId: LoopId): string {
  return path.join(loopsStateDir(), `${loopId}-traces.jsonl`);
}

/** A stable id for a trace, usable as an evidence `ref` by later loops. */
export function traceId(t: Pick<LoopTrace, "loopId" | "at">): string {
  return `${t.loopId}:${t.at}`;
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(loopsStateDir(), { recursive: true });
}

/**
 * Append one trace. Append-only — never rewrites the file. Best-effort: a
 * write failure is logged, not thrown (a loop run must not crash because the
 * audit write hiccuped). Returns the trace id.
 */
export async function appendTrace(trace: LoopTrace): Promise<string> {
  const id = traceId(trace);
  try {
    await ensureDir();
    await fsp.appendFile(
      loopTracePath(trace.loopId),
      JSON.stringify(trace) + "\n",
      "utf8"
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[loops] trace append failed (non-fatal): ${(e as Error).message}`);
  }
  return id;
}

function parseJsonl(raw: string): LoopTrace[] {
  const out: LoopTrace[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as LoopTrace;
      if (o && typeof o.loopId === "string") out.push(o);
    } catch {
      /* skip malformed line — never lose the whole file to one bad line */
    }
  }
  return out;
}

/** Read traces for one loop (most-recent first). `limit` caps the return. */
export async function readTraces(
  loopId: LoopId,
  limit = 100
): Promise<LoopTrace[]> {
  try {
    const raw = await fsp.readFile(loopTracePath(loopId), "utf8");
    const all = parseJsonl(raw);
    all.reverse();
    return limit > 0 ? all.slice(0, limit) : all;
  } catch {
    return [];
  }
}

/** Read traces across ALL loops (most-recent first), merged + capped. */
export async function readAllTraces(limit = 200): Promise<LoopTrace[]> {
  let files: string[] = [];
  try {
    files = (await fsp.readdir(loopsStateDir())).filter((f) =>
      f.endsWith("-traces.jsonl")
    );
  } catch {
    return [];
  }
  const all: LoopTrace[] = [];
  for (const f of files) {
    try {
      const raw = await fsp.readFile(path.join(loopsStateDir(), f), "utf8");
      all.push(...parseJsonl(raw));
    } catch {
      /* skip unreadable file */
    }
  }
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return limit > 0 ? all.slice(0, limit) : all;
}

/** The set of all existing trace ids — used by the eval gate's anti-gaming
 *  fabrication check (evidence citing a non-existent trace is fabricated). */
export async function collectTraceRefs(): Promise<Set<string>> {
  const refs = new Set<string>();
  const all = await readAllTraces(0);
  for (const t of all) refs.add(traceId(t));
  return refs;
}

export interface LoopTraceStats {
  totalTraces: number;
  byLoop: Record<string, number>;
  byOutcome: Record<string, number>;
  lastAt: string | null;
  pendingApproval: number;
  halted: number;
}

/** Aggregate stats for the HUD + loops page. */
export async function traceStats(): Promise<LoopTraceStats> {
  const all = await readAllTraces(0);
  const byLoop: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  let pendingApproval = 0;
  let halted = 0;
  for (const t of all) {
    byLoop[t.loopId] = (byLoop[t.loopId] ?? 0) + 1;
    byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
    if (t.outcome === "awaiting_approval") pendingApproval += 1;
    if (t.outcome === "halted") halted += 1;
  }
  return {
    totalTraces: all.length,
    byLoop,
    byOutcome,
    lastAt: all.length > 0 ? all[0].at : null,
    pendingApproval,
    halted,
  };
}

/** Pending high-risk proposals awaiting operator approval (for /approve-patch
 *  + the loops page). Returns the most recent awaiting_approval traces. */
export async function pendingApprovals(limit = 50): Promise<LoopTrace[]> {
  const all = await readAllTraces(0);
  return all.filter((t) => t.outcome === "awaiting_approval").slice(0, limit);
}
