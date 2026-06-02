// lib/memory-extract.ts
//
// Memory Phase (2026-06-02) — semantic cross-session memory: EXTRACTION +
// STORAGE, with operator AUDIT (2026-06-02 update).
//
// After each assistant turn, Bobby (the fastest model) extracts memorable
// facts the operator stated or implied. Facts are stored in two places:
//   A) <ARGOS_ROOT>/data/memory/shared/operator_facts.jsonl
//   B) <ARGOS_ROOT>/memory/MEMORY.md under "## Recent context"
//
// AUDIT additions:
//   - Every fact carries a stable `id` and a `status`
//     (unreviewed/approved/rejected/edited/flagged) so the operator can review
//     each one — the same discipline applied to Jenna.
//   - Every extraction call is logged with full transparency (the exact prompt
//     sent to Bobby + Bobby's raw response + parse result) to
//     state/memory-extractions/<sessionId>.jsonl, so the audit page can show
//     "what Bobby was told and what he actually said" for any fact.
//
// Doctrine: extraction NEVER blocks the chat response and NEVER throws.
// Server-only (node fs + local Ollama).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { argosRoot } from "./vault/paths";
import { getOllamaBase } from "./ollama-config";
import { PERSONA_BY_ID } from "./personas";

export type FactCategory =
  | "person"
  | "project"
  | "preference"
  | "concern"
  | "event";

/** Operator review lifecycle for an extracted fact. */
export type FactStatus =
  | "unreviewed" // default for new extractions
  | "approved" //   operator confirmed accurate
  | "rejected" //   operator removed from injection
  | "edited" //     operator modified the fact text
  | "flagged"; //   suspected hallucination — kept for analysis, NOT injected

export interface OperatorFact {
  id: string;
  fact: string;
  category: FactCategory;
  confidence: number;
  timestamp: string;
  sessionId: string | null;
  persona: string;
  status: FactStatus;
  /** Set when status === "edited" — the model's original text, preserved. */
  originalFact?: string;
  /** When the operator last set the status. */
  reviewedAt?: string;
}

const CATEGORIES = new Set<FactCategory>([
  "person",
  "project",
  "preference",
  "concern",
  "event",
]);
const MIN_CONFIDENCE = 0.7;
const MAX_FACTS_PER_TURN = 3;
const EXTRACT_TIMEOUT_MS = 45_000;
const MAX_EXCHANGE_CHARS = 2000; // keep Bobby fast on long turns

// ---------- paths ----------

export function operatorFactsPath(): string {
  return path.join(argosRoot(), "data", "memory", "shared", "operator_facts.jsonl");
}
export function memoryMdPath(): string {
  return path.join(argosRoot(), "memory", "MEMORY.md");
}
/** Per-session extraction transparency logs. */
export function extractionsDir(): string {
  return path.join(argosRoot(), "state", "memory-extractions");
}
function extractionFile(sessionId: string | null): string {
  const safe = (sessionId ?? "unsessioned").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unsessioned";
  return path.join(extractionsDir(), `${safe}.jsonl`);
}

/** Bobby is the extraction model (fastest in the roster). */
export function getExtractionModel(): string {
  return PERSONA_BY_ID.bobby?.model || "CyberCrew/notmythos-8b:latest";
}

/** Stable, deterministic id for a fact (so legacy facts get the SAME id on
 *  every read until persisted). Content-addressed. */
export function factId(f: { timestamp: string; fact: string; sessionId: string | null }): string {
  return createHash("sha1").update(`${f.timestamp}|${f.fact}|${f.sessionId ?? ""}`).digest("hex").slice(0, 12);
}

// ---------- extraction ----------

const EXTRACT_SYSTEM = "You are a fact-extraction tool. Output ONLY a JSON array, nothing else.";
const EXTRACT_INSTRUCTION =
  "Extract memorable facts from this exchange. Return JSON array of " +
  "{fact, category, confidence} where category is one of: person, project, " +
  "preference, concern, event. Only extract facts the operator stated or " +
  "implied. Return empty array if nothing memorable.";

function buildExtractUser(u: string, a: string): string {
  return `${EXTRACT_INSTRUCTION}\n\nOperator: ${u}\nAssistant: ${a}`;
}

/** Parse Bobby's output into validated facts (with id + status). */
function parseFacts(
  text: string,
  opts: { sessionId?: string | null; persona?: string }
): OperatorFact[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < 0 || end < start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const now = new Date().toISOString();
  const out: OperatorFact[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fact = typeof o.fact === "string" ? o.fact.trim() : "";
    if (!fact) continue;
    const category = o.category as FactCategory;
    if (!CATEGORIES.has(category)) continue;
    const confidence =
      typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) continue;
    const sessionId = opts.sessionId ?? null;
    const clipped = fact.slice(0, 280);
    out.push({
      id: factId({ timestamp: now, fact: clipped, sessionId }),
      fact: clipped,
      category,
      confidence: Math.min(1, Math.max(0, confidence)),
      timestamp: now,
      sessionId,
      persona: opts.persona ?? "bartimaeus",
      status: "unreviewed",
    });
    if (out.length >= MAX_FACTS_PER_TURN) break;
  }
  return out;
}

/**
 * Extract memorable facts from a single exchange using Bobby. Also logs the
 * full extraction transparency record (prompt + raw response + parse result).
 * Returns [] on any error. NEVER throws.
 */
export async function extractFacts(
  userMessage: string,
  assistantMessage: string,
  opts: { sessionId?: string | null; persona?: string } = {}
): Promise<OperatorFact[]> {
  const u = (userMessage ?? "").slice(0, MAX_EXCHANGE_CHARS).trim();
  const a = (assistantMessage ?? "").slice(0, MAX_EXCHANGE_CHARS).trim();
  if (!u) return [];
  const model = getExtractionModel();
  const userPrompt = buildExtractUser(u, a);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EXTRACT_TIMEOUT_MS);
  let raw = "";
  let facts: OperatorFact[] = [];
  let transportOk = false;
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: ctrl.signal,
    });
    if (res.ok) {
      transportOk = true;
      const j = (await res.json()) as { message?: { content?: string } };
      raw = j.message?.content ?? "";
      facts = parseFacts(raw, opts);
    }
  } catch {
    /* graceful */
  } finally {
    clearTimeout(timer);
  }

  // Transparency: log what Bobby was told + what he actually said.
  await writeExtractionRecord({
    at: new Date().toISOString(),
    sessionId: opts.sessionId ?? null,
    persona: opts.persona ?? "bartimaeus",
    model,
    userMessage: u,
    assistantMessage: a,
    systemPrompt: EXTRACT_SYSTEM,
    userPrompt,
    rawResponse: raw,
    transportOk,
    parseOk: facts.length > 0,
    factCount: facts.length,
    factIds: facts.map((f) => f.id),
  }).catch(() => {});

  return facts;
}

// ---------- extraction transparency log ----------

export interface ExtractionRecord {
  at: string;
  sessionId: string | null;
  persona: string;
  model: string;
  userMessage: string;
  assistantMessage: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  transportOk: boolean;
  parseOk: boolean;
  factCount: number;
  factIds: string[];
}

async function writeExtractionRecord(rec: ExtractionRecord): Promise<void> {
  await fsp.mkdir(extractionsDir(), { recursive: true });
  await fsp.appendFile(extractionFile(rec.sessionId), JSON.stringify(rec) + "\n", "utf8");
}

/** Read all extraction records for a session (most-recent first). */
export async function readExtractions(sessionId: string | null): Promise<ExtractionRecord[]> {
  try {
    const raw = await fsp.readFile(extractionFile(sessionId), "utf8");
    const out: ExtractionRecord[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as ExtractionRecord);
      } catch {
        /* skip malformed */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

/** Find the extraction record that produced a given fact id (scans the fact's
 *  session log). Returns null if not found. */
export async function findExtractionForFact(fact: OperatorFact): Promise<ExtractionRecord | null> {
  const recs = await readExtractions(fact.sessionId);
  return recs.find((r) => r.factIds.includes(fact.id)) ?? recs.find((r) => r.userMessage && fact.timestamp >= r.at) ?? null;
}

// ---------- storage ----------

/** Read all facts, backfilling id + status for legacy entries (deterministic
 *  id so the same legacy fact always resolves to the same id). Never throws. */
export async function readFacts(): Promise<OperatorFact[]> {
  try {
    const raw = await fsp.readFile(operatorFactsPath(), "utf8");
    const out: OperatorFact[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as Partial<OperatorFact>;
        if (!o || typeof o.fact !== "string") continue;
        const sessionId = o.sessionId ?? null;
        out.push({
          id: o.id || factId({ timestamp: o.timestamp ?? "", fact: o.fact, sessionId }),
          fact: o.fact,
          category: (o.category as FactCategory) ?? "event",
          confidence: typeof o.confidence === "number" ? o.confidence : 0,
          timestamp: o.timestamp ?? "",
          sessionId,
          persona: o.persona ?? "bartimaeus",
          status: (o.status as FactStatus) ?? "unreviewed",
          originalFact: o.originalFact,
          reviewedAt: o.reviewedAt,
        });
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function appendFactsJsonl(facts: OperatorFact[]): Promise<void> {
  const p = operatorFactsPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const lines = facts.map((f) => JSON.stringify(f)).join("\n") + "\n";
  await fsp.appendFile(p, lines, "utf8");
}

/** Atomically rewrite the whole fact store (used by status/edit/delete). The
 *  jsonl is a MUTABLE working set — the append-only audit lives in the
 *  hallucinations + extraction logs, not here. */
export async function rewriteFacts(facts: OperatorFact[]): Promise<void> {
  const p = operatorFactsPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, facts.map((f) => JSON.stringify(f)).join("\n") + (facts.length ? "\n" : ""), "utf8");
  await fsp.rename(tmp, p);
}

/** Append facts to MEMORY.md under "## Recent context". Atomic, append-only. */
async function appendToMemoryMd(facts: OperatorFact[]): Promise<void> {
  const p = memoryMdPath();
  let existing = "";
  try {
    existing = await fsp.readFile(p, "utf8");
  } catch {
    existing = "";
  }
  let out = existing.replace(/\s+$/, "");
  if (!/^##\s+Recent context/im.test(out)) {
    out +=
      "\n\n## Recent context\n\n" +
      "> Auto-captured facts the operator shared in chat. Append-only; never overwritten.\n";
  }
  const stamp = new Date().toISOString();
  const day = stamp.slice(0, 10);
  const time = stamp.slice(11, 16);
  const block = [
    "",
    `### ${day} ${time}Z`,
    ...facts.map((f) => `- [${f.category}] ${f.fact} (${f.confidence.toFixed(2)})`),
  ].join("\n");
  out = out + "\n" + block + "\n";

  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, out, "utf8");
  await fsp.rename(tmp, p);
}

/** Store facts to BOTH the jsonl log and MEMORY.md. Each sink independently
 *  guarded — never throws. */
export async function storeFacts(facts: OperatorFact[]): Promise<void> {
  if (!facts || facts.length === 0) return;
  try {
    await appendFactsJsonl(facts);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[memory] facts jsonl append failed: ${(e as Error).message}`);
  }
  try {
    await appendToMemoryMd(facts);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[memory] MEMORY.md append failed: ${(e as Error).message}`);
  }
}

/** Clear the extracted-facts log. Does NOT touch MEMORY.md. Returns count. */
export async function clearFacts(): Promise<number> {
  const before = await readFacts();
  try {
    await fsp.writeFile(operatorFactsPath(), "", "utf8");
  } catch {
    /* nothing to clear */
  }
  return before.length;
}

export interface FactsStatus {
  count: number;
  recent: OperatorFact[];
  memoryMdUpdated: string | null;
  memoryMdExists: boolean;
}

export async function factsStatus(): Promise<FactsStatus> {
  const facts = await readFacts();
  let memoryMdUpdated: string | null = null;
  let memoryMdExists = false;
  try {
    const st = await fsp.stat(memoryMdPath());
    memoryMdExists = true;
    memoryMdUpdated = new Date(st.mtimeMs).toISOString();
  } catch {
    /* MEMORY.md absent */
  }
  return {
    count: facts.length,
    recent: facts.slice(-5).reverse(),
    memoryMdUpdated,
    memoryMdExists,
  };
}

// ---------- orchestration ----------

export async function extractStoreAwait(
  userMessage: string,
  assistantMessage: string,
  opts: { sessionId?: string | null; persona?: string } = {}
): Promise<OperatorFact[]> {
  try {
    const facts = await extractFacts(userMessage, assistantMessage, opts);
    if (facts.length > 0) await storeFacts(facts);
    return facts;
  } catch {
    return [];
  }
}

export function extractAndStore(
  userMessage: string,
  assistantMessage: string,
  opts: { sessionId?: string | null; persona?: string } = {}
): void {
  void extractStoreAwait(userMessage, assistantMessage, opts);
}

// Re-export randomUUID-based id for callers that mint explicit facts.
export function newFactId(): string {
  return randomUUID().slice(0, 12);
}
