// lib/observation.ts
//
// Phase 3 (2026-06-10, owner scope-add) — THE OBSERVATION CORPUS.
//
// Every owner↔persona exchange is logged to state/observation.jsonl,
// hash-chained under the SAME doctrine as the audit chain (lib/audit.ts):
// each entry hash-links to its predecessor via sha256(prevHash + ":" +
// canonicalJson(entryWithoutHash)); tamper detection walks the chain.
// canonicalJson/computeEntryHash are REUSED from lib/audit.ts so the two
// chains can never drift in hashing semantics.
//
// Schema per the owner directive: timestamp, persona, topic_class,
// query_type, session_id, sequence_position. Chain fields (version, index,
// prevHash, hash) ride alongside, exactly as in the audit chain.
//
// CAPTURE ONLY — no consumer in Phase 3. (Phase 4's prediction layer is the
// consumer: abductive/temporal reasoning over this corpus.) Capture is
// fire-and-forget from the chat orchestrator's stream-close path: zero added
// latency, zero model calls (classifiers are keyword heuristics), failures
// are swallowed — chat never breaks on observation problems.
//
// PRIVACY NOTE: the corpus stores CLASSES, not content. No query text, no
// reply text — topic_class + query_type only. Local file, never served.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import { canonicalJson, computeEntryHash } from "./audit";

export const OBSERVATION_VERSION = 1;

export type TopicClass =
  | "ops_files"      // file/dir operations, workspace management
  | "research_web"   // lookups, current facts, research asks
  | "canon_persona"  // Bart canon, persona identity/voice
  | "security"       // auth, gates, audit, threat surface
  | "system_argos"   // ARGOS itself: build, phases, models, hardware
  | "schedule_tasks" // reminders, overnight tasks, time-based asks
  | "comms_email"    // email, messages, drafts
  | "coding"         // code, scripts, debugging
  | "smalltalk"      // greetings, banter, identity pings
  | "other";

export type QueryType =
  | "question"   // interrogative — wants information
  | "command"    // imperative — wants an action performed
  | "followup"   // short continuation riding on prior context
  | "statement"; // declarative — shares information/context

export interface ObservationEntry {
  version: number;
  index: number;             // monotonic from 0
  timestamp: string;         // ISO 8601
  persona: string;
  topic_class: TopicClass;
  query_type: QueryType;
  session_id: string | null;
  sequence_position: number; // 1-based count of user turns incl. this one
  prevHash: string;          // "" for genesis
  hash: string;
}

export function observationPath(): string {
  return path.join(argosRoot(), "state", "observation.jsonl");
}

// ---- deterministic classifiers (CPU-only, zero model calls) ----

const TOPIC_RULES: Array<{ klass: TopicClass; re: RegExp }> = [
  { klass: "comms_email", re: /\b(email|inbox|draft|gmail|message|reply to|send (him|her|them))\b/i },
  { klass: "schedule_tasks", re: /\b(remind|schedule|overnight|tonight|tomorrow|queue (a |up )?task|every (day|morning|week)|at \d{1,2}(:\d{2})?\s?(am|pm)?)\b/i },
  { klass: "ops_files", re: /\b(file|folder|director(y|ies)|move|copy|delete|rename|mkdir|save|workspace|\.md|\.txt|\.json)\b/i },
  { klass: "security", re: /\b(auth|pin|session|token|gate|audit|tamper|secur|threat|tailscale|permission|approv)\b/i },
  { klass: "coding", re: /\b(code|script|function|bug|debug|typescript|javascript|python|compile|refactor|stack ?trace)\b/i },
  { klass: "system_argos", re: /\b(argos|ollama|model|gpu|vram|persona|vault|phase \d|launcher|m\.2|usb|build|deploy)\b/i },
  { klass: "canon_persona", re: /\b(bartimaeus|djinn|pentacle|ptolemy|nathaniel|kitty|faquarl|jabor|nouda|lovelace|amulet|samarkand|golem|stroud|canon)\b/i },
  { klass: "research_web", re: /\b(search|look (it |this )?up|research|who is|what is the (latest|current)|news|price|weather|find out)\b/i },
  { klass: "smalltalk", re: /^(hi|hey|hello|yo|good (morning|evening|night)|thanks?|thank you|identify yourself|who are you)\b/i },
];

export function classifyTopic(text: string): TopicClass {
  const t = (text ?? "").trim();
  if (!t) return "other";
  for (const r of TOPIC_RULES) {
    if (r.re.test(t)) return r.klass;
  }
  return "other";
}

const COMMAND_VERB_RE =
  /^(\/deep\s+)?(write|create|make|move|copy|delete|remove|rename|save|run|execute|search|find|look|fetch|get|list|show|open|read|summari[sz]e|draft|send|queue|schedule|remind|check|verify|scan|build|fix|update|generate|analy[sz]e|compare|explain|give|tell|describe|identify|state|comment|offer|name|reflect)\b/i;

export function classifyQueryType(text: string, sequencePosition: number): QueryType {
  const t = (text ?? "").trim();
  if (!t) return "statement";
  // Short continuations on an established thread read as follow-ups —
  // checked FIRST so "and why that one?" lands followup, not question.
  if (sequencePosition > 1 && (t.length <= 40 || /^(and|also|then|what about|why|how about|ok(ay)?[,.]?|but)\b/i.test(t))) {
    return "followup";
  }
  if (/\?\s*$/.test(t) || /^(who|what|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will)\b/i.test(t)) {
    return "question";
  }
  if (COMMAND_VERB_RE.test(t)) return "command";
  return "statement";
}

// ---- chain append / read / verify (audit-chain doctrine) ----

interface TailCache {
  index: number;
  hash: string;
  mtimeMs: number;
  sizeBytes: number;
}
let tailCache: TailCache | null = null;

/** Test-only. */
export function _resetObservationTailCache(): void {
  tailCache = null;
}

async function statFile(): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try {
    const s = await fsp.stat(observationPath());
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function readObservations(): Promise<ObservationEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(observationPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: ObservationEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ObservationEntry);
    } catch {
      /* malformed line — verifier flags it via index walk */
    }
  }
  return out;
}

export interface ObserveInput {
  persona: string;
  userText: string;
  sessionId: string | null;
  /** 1-based count of user turns in the thread including this one. */
  sequencePosition: number;
  timestamp?: string;
}

/** Append one observation. Same tail-cache + hash mechanics as appendAudit.
 *  Throws only on filesystem failure — callers in the chat path must wrap
 *  fire-and-forget. */
export async function appendObservation(input: ObserveInput): Promise<ObservationEntry> {
  await fsp.mkdir(path.dirname(observationPath()), { recursive: true });

  let prevHash: string;
  let nextIndex: number;
  const st = await statFile();
  if (
    tailCache !== null &&
    st !== null &&
    st.mtimeMs === tailCache.mtimeMs &&
    st.sizeBytes === tailCache.sizeBytes
  ) {
    prevHash = tailCache.hash;
    nextIndex = tailCache.index + 1;
  } else {
    const existing = await readObservations();
    const last = existing[existing.length - 1];
    prevHash = last?.hash ?? "";
    nextIndex = existing.length;
  }

  const entryWithoutHash: Omit<ObservationEntry, "hash"> = {
    version: OBSERVATION_VERSION,
    index: nextIndex,
    timestamp: input.timestamp ?? new Date().toISOString(),
    persona: input.persona,
    topic_class: classifyTopic(input.userText),
    query_type: classifyQueryType(input.userText, input.sequencePosition),
    session_id: input.sessionId,
    sequence_position: input.sequencePosition,
    prevHash,
  };
  const hash = computeEntryHash(entryWithoutHash as unknown as Parameters<typeof computeEntryHash>[0]);
  const entry: ObservationEntry = { ...entryWithoutHash, hash };

  await fsp.appendFile(observationPath(), JSON.stringify(entry) + "\n", "utf8");

  const after = await statFile();
  tailCache = after !== null ? { index: nextIndex, hash, mtimeMs: after.mtimeMs, sizeBytes: after.sizeBytes } : null;
  return entry;
}

export interface ObservationVerifyResult {
  ok: boolean;
  totalEntries: number;
  brokenAtIndex: number | null;
  brokenReason: string | null;
  lastHash: string | null;
}

/** Walk the chain genesis→tail; same checks as verifyChain in lib/audit.ts. */
export async function verifyObservationChain(): Promise<ObservationVerifyResult> {
  const entries = await readObservations();
  if (entries.length === 0) {
    return { ok: true, totalEntries: 0, brokenAtIndex: null, brokenReason: null, lastHash: null };
  }
  let prevHash = "";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.index !== i) {
      return { ok: false, totalEntries: entries.length, brokenAtIndex: i, brokenReason: `index mismatch: file position ${i} but entry.index = ${e.index}`, lastHash: entries[entries.length - 1].hash };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, totalEntries: entries.length, brokenAtIndex: i, brokenReason: `prevHash mismatch at index ${i}`, lastHash: entries[entries.length - 1].hash };
    }
    const { hash: stored, ...rest } = e;
    const expected = computeEntryHash(rest as unknown as Parameters<typeof computeEntryHash>[0]);
    if (expected !== stored) {
      return { ok: false, totalEntries: entries.length, brokenAtIndex: i, brokenReason: `hash mismatch at index ${i} — entry tampered`, lastHash: entries[entries.length - 1].hash };
    }
    prevHash = stored;
  }
  // Re-serialize check is implicit: computeEntryHash uses canonicalJson, the
  // same function the writer used.
  void canonicalJson; // (documents the shared dependency for grep proofs)
  return { ok: true, totalEntries: entries.length, brokenAtIndex: null, brokenReason: null, lastHash: prevHash };
}
