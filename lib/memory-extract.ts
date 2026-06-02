// lib/memory-extract.ts
//
// Memory Phase (2026-06-02) — semantic cross-session memory: EXTRACTION +
// STORAGE.
//
// After each assistant turn, Bobby (the fastest model) extracts memorable
// facts the operator stated or implied. Facts are stored in two places:
//   A) <ARGOS_ROOT>/data/memory/shared/operator_facts.jsonl  (append-only)
//   B) <ARGOS_ROOT>/memory/MEMORY.md under a "## Recent context" section
//      (atomic temp+rename; never overwrites existing content)
//
// Doctrine: extraction NEVER blocks the chat response (fire-and-forget) and
// NEVER throws — every path degrades silently. Bobby is the extraction model.
//
// Server-only (node fs + local Ollama).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import { getOllamaBase } from "./ollama-config";
import { PERSONA_BY_ID } from "./personas";

export type FactCategory =
  | "person"
  | "project"
  | "preference"
  | "concern"
  | "event";

export interface OperatorFact {
  fact: string;
  category: FactCategory;
  confidence: number;
  timestamp: string;
  sessionId: string | null;
  persona: string;
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

/** Bobby is the extraction model (fastest in the roster). Resolved from the
 *  static registry; falls back to the known tag if the registry shifts. */
export function getExtractionModel(): string {
  return PERSONA_BY_ID.bobby?.model || "CyberCrew/notmythos-8b:latest";
}

// ---------- extraction ----------

const EXTRACT_INSTRUCTION =
  "Extract memorable facts from this exchange. Return JSON array of " +
  "{fact, category, confidence} where category is one of: person, project, " +
  "preference, concern, event. Only extract facts the operator stated or " +
  "implied. Return empty array if nothing memorable.";

/** Parse Bobby's output into validated facts. Lenient: pulls the JSON array
 *  out of any surrounding prose, filters by category + confidence, caps at 3. */
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
    out.push({
      fact: fact.slice(0, 280),
      category,
      confidence: Math.min(1, Math.max(0, confidence)),
      timestamp: now,
      sessionId: opts.sessionId ?? null,
      persona: opts.persona ?? "bartimaeus",
    });
    if (out.length >= MAX_FACTS_PER_TURN) break;
  }
  return out;
}

/**
 * Extract memorable facts from a single exchange using Bobby. Returns [] on
 * any error (Ollama down, model missing, bad JSON, empty input). NEVER throws.
 */
export async function extractFacts(
  userMessage: string,
  assistantMessage: string,
  opts: { sessionId?: string | null; persona?: string } = {}
): Promise<OperatorFact[]> {
  const u = (userMessage ?? "").slice(0, MAX_EXCHANGE_CHARS).trim();
  const a = (assistantMessage ?? "").slice(0, MAX_EXCHANGE_CHARS).trim();
  if (!u) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: getExtractionModel(),
        stream: false,
        think: false,
        messages: [
          {
            role: "system",
            content:
              "You are a fact-extraction tool. Output ONLY a JSON array, nothing else.",
          },
          { role: "user", content: `${EXTRACT_INSTRUCTION}\n\nOperator: ${u}\nAssistant: ${a}` },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { message?: { content?: string } };
    return parseFacts(j.message?.content ?? "", opts);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------- storage ----------

export async function readFacts(): Promise<OperatorFact[]> {
  try {
    const raw = await fsp.readFile(operatorFactsPath(), "utf8");
    const out: OperatorFact[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as OperatorFact;
        if (o && typeof o.fact === "string") out.push(o);
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

/** Append facts to MEMORY.md under "## Recent context". Atomic (temp+rename),
 *  append-only — existing content is preserved verbatim. */
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

/** Store facts to BOTH the jsonl log and MEMORY.md. Each sink is independently
 *  guarded — a failure in one never blocks the other and never throws. */
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

/** Clear the extracted-facts log (operator_facts.jsonl). Does NOT touch
 *  MEMORY.md (the operator profile is sacred). Returns the count cleared. */
export async function clearFacts(): Promise<number> {
  const before = await readFacts();
  try {
    await fsp.writeFile(operatorFactsPath(), "", "utf8");
  } catch {
    /* nothing to clear / dir missing — treat as 0 effect */
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

/** Extract + store, awaiting the result. Used by the API/smoke. Returns the
 *  facts stored (possibly empty). Never throws. */
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

/** Fire-and-forget extraction + storage. Returns immediately; the chat
 *  response is never blocked or affected by memory work. */
export function extractAndStore(
  userMessage: string,
  assistantMessage: string,
  opts: { sessionId?: string | null; persona?: string } = {}
): void {
  void extractStoreAwait(userMessage, assistantMessage, opts);
}
