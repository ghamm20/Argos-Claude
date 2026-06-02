// lib/memory-audit.ts
//
// Memory Audit Interface (2026-06-02) — operator review of every fact Bobby
// extracts, the same discipline applied to Jenna: catch hallucinations and bad
// reasoning before they get injected into prompts.
//
//   - Fact lifecycle: setFactStatus / editFact / bulk ops (the jsonl is a
//     mutable working set; status changes rewrite it atomically).
//   - Hallucination tracking: every flagged fact is appended to an APPEND-ONLY
//     log (state/memory-hallucinations.jsonl) with the reason, the session
//     context, and the extraction model — for pattern analysis.
//   - Filtering / sorting / CSV export for an efficient audit.
//
// Server-only (node fs).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import {
  readFacts,
  rewriteFacts,
  getExtractionModel,
  findExtractionForFact,
  type OperatorFact,
  type FactStatus,
  type FactCategory,
} from "./memory-extract";

// ---------- hallucination log (append-only) ----------

export function hallucinationsPath(): string {
  return path.join(argosRoot(), "state", "memory-hallucinations.jsonl");
}

export interface HallucinationRecord {
  at: string;
  factId: string;
  fact: string;
  originalFact?: string;
  category: string;
  persona: string;
  sessionId: string | null;
  reason: string;
  extractionModel: string;
  /** A snippet of the conversation turn that produced it, if recoverable. */
  sessionContext: string | null;
}

async function appendHallucination(rec: HallucinationRecord): Promise<void> {
  await fsp.mkdir(path.dirname(hallucinationsPath()), { recursive: true });
  await fsp.appendFile(hallucinationsPath(), JSON.stringify(rec) + "\n", "utf8");
}

export async function readHallucinations(): Promise<HallucinationRecord[]> {
  try {
    const raw = await fsp.readFile(hallucinationsPath(), "utf8");
    const out: HallucinationRecord[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as HallucinationRecord);
      } catch {
        /* skip */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export interface HallucinationStats {
  total: number;
  byCategory: Record<string, number>;
  bySession: Record<string, number>;
  byPersona: Record<string, number>;
  byDay: Record<string, number>;
  worstCategory: string | null;
  worstPersona: string | null;
  worstSession: string | null;
}

function topKey(rec: Record<string, number>): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of Object.entries(rec)) if (v > n) { n = v; best = k; }
  return best;
}

export async function hallucinationStats(): Promise<HallucinationStats> {
  const items = await readHallucinations();
  const byCategory: Record<string, number> = {};
  const bySession: Record<string, number> = {};
  const byPersona: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  for (const h of items) {
    byCategory[h.category] = (byCategory[h.category] ?? 0) + 1;
    const s = h.sessionId ?? "(no-session)";
    bySession[s] = (bySession[s] ?? 0) + 1;
    byPersona[h.persona] = (byPersona[h.persona] ?? 0) + 1;
    const day = (h.at ?? "").slice(0, 10) || "unknown";
    byDay[day] = (byDay[day] ?? 0) + 1;
  }
  return {
    total: items.length,
    byCategory,
    bySession,
    byPersona,
    byDay,
    worstCategory: topKey(byCategory),
    worstPersona: topKey(byPersona),
    worstSession: topKey(bySession),
  };
}

// ---------- fact lifecycle ----------

export interface SetStatusOpts {
  reason?: string; // required-ish for "flagged"
  editedText?: string; // required for "edited"
}

export interface SetStatusResult {
  ok: boolean;
  fact: OperatorFact | null;
  error?: string;
}

/** Set one fact's status. For "edited" the text is replaced (original kept);
 *  for "flagged" a hallucination record is appended. Atomic rewrite. */
export async function setFactStatus(
  id: string,
  status: FactStatus,
  opts: SetStatusOpts = {}
): Promise<SetStatusResult> {
  const facts = await readFacts();
  const idx = facts.findIndex((f) => f.id === id);
  if (idx < 0) return { ok: false, fact: null, error: `no fact with id ${id}` };
  const f = facts[idx];
  const now = new Date().toISOString();

  if (status === "edited") {
    const newText = (opts.editedText ?? "").trim();
    if (!newText) return { ok: false, fact: null, error: "editedText required for status 'edited'" };
    if (f.originalFact === undefined) f.originalFact = f.fact;
    f.fact = newText.slice(0, 280);
  }

  f.status = status;
  f.reviewedAt = now;
  facts[idx] = f;
  await rewriteFacts(facts);

  if (status === "flagged") {
    let sessionContext: string | null = null;
    let model = getExtractionModel();
    try {
      const ex = await findExtractionForFact(f);
      if (ex) {
        model = ex.model || model;
        sessionContext = `Operator: ${ex.userMessage}\nAssistant: ${ex.assistantMessage}`.slice(0, 1200);
      }
    } catch {
      /* context best-effort */
    }
    await appendHallucination({
      at: now,
      factId: f.id,
      fact: f.fact,
      originalFact: f.originalFact,
      category: f.category,
      persona: f.persona,
      sessionId: f.sessionId,
      reason: opts.reason?.slice(0, 500) || "(no reason given)",
      extractionModel: model,
      sessionContext,
    }).catch(() => {});
  }

  return { ok: true, fact: f };
}

export interface BulkResult {
  ok: boolean;
  updated: number;
  ids: string[];
}

/** Bulk status change (single atomic rewrite). flagged-in-bulk also logs each. */
export async function bulkSetStatus(ids: string[], status: FactStatus, reason?: string): Promise<BulkResult> {
  const idset = new Set(ids);
  const facts = await readFacts();
  const now = new Date().toISOString();
  const changed: OperatorFact[] = [];
  for (const f of facts) {
    if (!idset.has(f.id)) continue;
    if (status === "edited") continue; // edit is per-fact only
    f.status = status;
    f.reviewedAt = now;
    changed.push(f);
  }
  if (changed.length > 0) await rewriteFacts(facts);
  if (status === "flagged") {
    for (const f of changed) {
      // eslint-disable-next-line no-await-in-loop
      await setFlaggedLog(f, reason).catch(() => {});
    }
  }
  return { ok: true, updated: changed.length, ids: changed.map((f) => f.id) };
}

async function setFlaggedLog(f: OperatorFact, reason?: string): Promise<void> {
  let sessionContext: string | null = null;
  let model = getExtractionModel();
  try {
    const ex = await findExtractionForFact(f);
    if (ex) {
      model = ex.model || model;
      sessionContext = `Operator: ${ex.userMessage}\nAssistant: ${ex.assistantMessage}`.slice(0, 1200);
    }
  } catch {
    /* best-effort */
  }
  await appendHallucination({
    at: new Date().toISOString(),
    factId: f.id,
    fact: f.fact,
    originalFact: f.originalFact,
    category: f.category,
    persona: f.persona,
    sessionId: f.sessionId,
    reason: reason?.slice(0, 500) || "(bulk flag)",
    extractionModel: model,
    sessionContext,
  });
}

/** Approve every UNREVIEWED fact from a session. */
export async function approveSession(sessionId: string): Promise<BulkResult> {
  const facts = await readFacts();
  const now = new Date().toISOString();
  const changed: string[] = [];
  for (const f of facts) {
    if (f.sessionId === sessionId && f.status === "unreviewed") {
      f.status = "approved";
      f.reviewedAt = now;
      changed.push(f.id);
    }
  }
  if (changed.length) await rewriteFacts(facts);
  return { ok: true, updated: changed.length, ids: changed };
}

/** Reject every UNREVIEWED fact older than `days`. */
export async function rejectUnreviewedOlderThan(days: number): Promise<BulkResult> {
  const cutoff = Date.now() - days * 86_400_000;
  const facts = await readFacts();
  const now = new Date().toISOString();
  const changed: string[] = [];
  for (const f of facts) {
    if (f.status !== "unreviewed") continue;
    const t = Date.parse(f.timestamp);
    if (Number.isFinite(t) && t < cutoff) {
      f.status = "rejected";
      f.reviewedAt = now;
      changed.push(f.id);
    }
  }
  if (changed.length) await rewriteFacts(facts);
  return { ok: true, updated: changed.length, ids: changed };
}

// ---------- filter / sort / export ----------

export interface FactFilters {
  category?: string;
  persona?: string;
  status?: string;
  minConfidence?: number;
  maxConfidence?: number;
  from?: string; // ISO date (inclusive)
  to?: string; // ISO date (inclusive)
  search?: string; // fact-text substring
}

export function filterFacts(facts: OperatorFact[], f: FactFilters): OperatorFact[] {
  const search = f.search?.trim().toLowerCase();
  return facts.filter((x) => {
    if (f.category && f.category !== "all" && x.category !== f.category) return false;
    if (f.persona && f.persona !== "all" && x.persona !== f.persona) return false;
    if (f.status && f.status !== "all" && x.status !== f.status) return false;
    if (typeof f.minConfidence === "number" && x.confidence < f.minConfidence) return false;
    if (typeof f.maxConfidence === "number" && x.confidence > f.maxConfidence) return false;
    if (f.from && x.timestamp.slice(0, 10) < f.from) return false;
    if (f.to && x.timestamp.slice(0, 10) > f.to) return false;
    if (search && !x.fact.toLowerCase().includes(search)) return false;
    return true;
  });
}

export type SortKey = "timestamp" | "persona" | "category" | "confidence" | "status" | "fact";

export function sortFacts(facts: OperatorFact[], key: SortKey, dir: "asc" | "desc" = "desc"): OperatorFact[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...facts].sort((a, b) => {
    let av: string | number = a[key] as string;
    let bv: string | number = b[key] as string;
    if (key === "confidence") {
      av = a.confidence;
      bv = b.confidence;
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function factsToCsv(facts: OperatorFact[]): string {
  const header = ["id", "timestamp", "persona", "category", "confidence", "status", "sessionId", "fact"];
  const rows = facts.map((f) =>
    [f.id, f.timestamp, f.persona, f.category, String(f.confidence), f.status, f.sessionId ?? "", f.fact]
      .map((c) => csvEscape(String(c)))
      .join(",")
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

export interface AuditSummary {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  byPersona: Record<string, number>;
  sessions: string[];
}

export async function auditSummary(): Promise<AuditSummary> {
  const facts = await readFacts();
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byPersona: Record<string, number> = {};
  const sessions = new Set<string>();
  for (const f of facts) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    byPersona[f.persona] = (byPersona[f.persona] ?? 0) + 1;
    if (f.sessionId) sessions.add(f.sessionId);
  }
  return { total: facts.length, byStatus, byCategory, byPersona, sessions: [...sessions] };
}

export type { OperatorFact, FactStatus, FactCategory };
