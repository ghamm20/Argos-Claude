import { NextRequest } from "next/server";
import { isPersonaSelectable, type PersonaId } from "@/lib/personas";
import { resolvePersona } from "@/lib/persona-server";
import { retrieve } from "@/lib/vault/store";
import type { Confidence, RetrievalHit } from "@/lib/vault/types";
import { AVAILABLE_MODELS, isAvailableModel } from "@/lib/store";
import { getAvailableModelsAdditions } from "@/lib/persona-overrides";
import { getOllamaBase, KEEP_ALIVE_CONVERSATIONAL } from "@/lib/ollama-config";
// Vision Phase 1 (2026-06-02) — image turns route to the multimodal model
// (gemma4-turbo) regardless of persona; text turns stay on the persona model.
// The persona system prompt is still injected, so the reply stays in
// character — only the MODEL changes.
import {
  messagesHaveImages,
  resolveChatModel,
  stripDataUrl,
} from "@/lib/vision";
// Memory Phase (2026-06-02) — semantic cross-session memory. Recall is
// prepended to the system prompt (additive); extraction runs fire-and-forget
// after the stream closes (Bobby). Both degrade silently — chat never breaks.
import { retrieveMemories } from "@/lib/memory-retrieve";
import { extractAndStore } from "@/lib/memory-extract";
// Tools Phase (2026-06-02) — Bartimaeus tool suite. Tool awareness is injected
// into his system prompt; <tool>{...}</tool> calls in his reply route through
// the governance executor (disclose/approve/restore/audit). Graceful: a tool
// failure is reported, chat continues.
import {
  buildToolAwarenessBlock,
  parseToolCalls,
  continuationPrompt,
} from "@/lib/tools/chat-tools";
import { requestTool } from "@/lib/tools/executor";
import { appendParseFailureAudit } from "@/lib/tools/audit";
import { toolSummaries } from "@/lib/tools/registry";
// v2.3.11 — per-persona tool distribution (scoped awareness + execution enforcement).
import { toolsForPersona, personaHasTool } from "@/lib/persona-tool-subsets";
// Model-integrity guard (v2.3.8) — flags a turn that CLAIMS tool execution
// when no tool actually ran. The doctrine backstop against fake success.
import {
  evaluateIntegrity,
  buildIntegrityWarning,
  INTEGRITY_WARNING_REASON,
  inferMissingTool,
  isExplicitToolRequest,
  hasMalformedToolTag,
  PARSE_FAILURE_SYSTEM_NOTE,
  FABRICATION_SYSTEM_NOTE,
  // v2.3.9 misrepresentation guard
  type ToolResultLike,
  isNegativeStateResult,
  detectMisrepresentation,
  buildMisrepresentationWarning,
  buildRecentToolResultsBlock,
  buildMisrepCorrectionNote,
} from "@/lib/tool-integrity";
import { appendIntegrityViolation } from "@/lib/integrity-log";

// Tool ids for inferMissingTool (which tool the model falsely claimed).
const KNOWN_TOOL_IDS = toolSummaries().map((t) => t.id);
// Forced current-facts grounding (2026-06-02) — time-sensitive queries get a
// live web_search injected as authoritative context so Bart can't answer
// office-holders / "current X" / 2026 facts from stale training data.
import { detectCurrentFacts, buildCurrentFactsBlock, buildChainBlock, buildNoGroundingBlock } from "@/lib/current-facts-detector";
// Weather now routes to the structured Open-Meteo tool instead of a reshaped
// DDG search (2026-06-02). buildWeatherBlock formats its result as grounding.
import { buildWeatherBlock } from "@/lib/tools/open-meteo";
// Phase 9 (router) — persona auto-routing suggestion. The chat path
// uses ONLY the keyword classifier (pure CPU, sub-millisecond) so it
// adds zero latency and never calls a model. Suggestion-only.
import { classifyByKeyword, ROUTE_CONFIDENCE_THRESHOLD } from "@/lib/persona-router";
// Phase 9 — persistent memory. Retrieval injects context into the
// system prompt; extractor runs async after the stream completes.
// All memory operations are wrapped in try/catch — memory failures
// must NEVER break chat.
import { retrieveMemoriesForPrompt } from "@/lib/memory/retriever";
import { extractMemories } from "@/lib/memory/extractor";
import {
  writeMemory,
  getOperatorProfile,
  initMemoryStore,
} from "@/lib/memory/store";
import type { MemoryPersonaScope } from "@/lib/memory/schema";
// Operator Auth (2026-05-28) — auth-mode gate.
import { readSettings } from "@/lib/settings";
import { parseBearer, isTokenValid } from "@/lib/auth";
// v2.4.2 Phase A — inference backend switch (local Ollama OR Nous free tier)
// + the useReboundModels LOCAL model swap. The Nous path is non-streamed and
// falls back to local silently on any failure. See lib/inference-backend.ts.
import {
  resolveBackend,
  resolveLocalModel,
  resolveCloudDataPolicy,
  callNous,
  type NousResult,
} from "@/lib/inference-backend";
import { decryptSecret } from "@/lib/web/secrets";
// v2.4.2 Phase A — durable per-turn inference audit (backend + exact model +
// latency + tokens + fallback reason). No pre-existing chat audit event existed.
import { appendAudit } from "@/lib/audit";
// Phase 10 (2026-05-28) — research orchestrator. needsResearch is
// imported alongside so we can short-circuit without touching the
// network on non-research turns.
import { runResearch } from "@/lib/research";
import type { ResearchReport } from "@/lib/research/types";
// Phase 11 — in-flight chat tracking + scheduler boot + post-hook.
import { begin as beginInFlight, end as endInFlight } from "@/lib/chat/inflight";
import { ensureSchedulerStarted } from "@/lib/research/scheduler";
// Phase 10 Heartbeat — ambient autonomous dispatcher. Booted here too
// (in addition to the launcher curl + status route) so it starts on
// first chat in dev even without the launcher.
import { ensureHeartbeatStarted } from "@/lib/heartbeat";
// Overnight Engine (2026-06-02) — boot the task scheduler (queue pump + morning
// brief). Always-on; only acts when the operator drops a task. Idempotent.
import { ensureTaskSchedulerStarted } from "@/lib/task-scheduler";
// Self-Evolving Loop Suite (2026-06-02) — boot the loop scheduler (scheduled
// improvement loops: nightly 2AM, Sunday 3AM, Friday 11PM, Saturday 2AM).
// Autorun-gated; only fires in-window. Idempotent.
import { ensureLoopSchedulerStarted } from "@/lib/loops/scheduler";
import { afterReport } from "@/lib/research/afterReport";

// Module-level init kicker — runs once per process lifetime when this
// module first loads. Best-effort: failures here just mean the first
// memory write will run init lazily anyway (initMemoryStore is
// idempotent). Fire-and-forget.
void initMemoryStore().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[chat] memory store init failed (will retry lazily): ${
      (e as Error).message
    }`
  );
});

// Phase 11 — scheduler boot. Reads settings + starts the background
// timers when settings.researchSchedule.enabled is true. No-op when
// the operator hasn't enabled the scheduler. Idempotent.
void ensureSchedulerStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[chat] scheduler boot failed: ${(e as Error).message}`
  );
});

// Phase 10 Heartbeat — boot the ambient dispatcher. No-op when
// settings.heartbeat.enabled is false. Idempotent.
void ensureHeartbeatStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(`[chat] heartbeat boot failed: ${(e as Error).message}`);
});

// Overnight Engine — boot the task scheduler. No-op work until a task is
// dropped into ARGOS_ROOT/tasks/queue/. Idempotent.
void ensureTaskSchedulerStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(`[chat] task scheduler boot failed: ${(e as Error).message}`);
});

// Self-Evolving Loop Suite — boot the loop scheduler. Dormant unless a
// scheduled loop's window is hit (and ARGOS_LOOPS_AUTORUN is on). Idempotent.
void ensureLoopSchedulerStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(`[chat] loop scheduler boot failed: ${(e as Error).message}`);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OLLAMA_BASE = getOllamaBase();
const OLLAMA_CHAT = `${OLLAMA_BASE}/api/chat`;
const FIRST_TOKEN_TIMEOUT_MS = 60_000;
const DEFAULT_TOP_K = 5;
// Input bounds — defense against pathological clients and accidental
// huge histories. The chat route is local-only by Seven Rules but
// defensive bounds keep a stuck client from OOMing the daemon.
const MAX_MESSAGES = 200;
const MAX_CONTENT_LENGTH = 100_000; // 100 KB per message
const VALID_ROLES = new Set<WireRole>(["user", "assistant", "system"]);

type WireRole = "user" | "assistant" | "system";

interface WireMessage {
  role: WireRole;
  content: string;
  /** Vision Phase 1 — base64 (data-URL or raw) images on a user turn. */
  images?: string[];
  /** v2.3.9 — tool results the client already received on an assistant turn.
   *  Used to surface prior tool outcomes to the model + drive the
   *  misrepresentation guard. NOT forwarded to Ollama (ollamaMessages maps
   *  only role/content/images). */
  toolResults?: Array<{ toolId?: string; ok?: boolean; summary?: string | null; data?: unknown; error?: string | null }>;
}

// Vision bounds — images are large; keep them off the 100 KB content cap but
// still bounded so a stuck client can't OOM the daemon.
const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_IMAGE_CHARS = 15 * 1024 * 1024; // ~11 MB binary as base64

interface ChatRequestBody {
  messages: WireMessage[];
  personaId: PersonaId;
  model: string;
  useRetrieval?: boolean;
  topK?: number;
  truthMode?: boolean;
}

const TRUTH_MODE_CLAUSE = [
  "",
  "TRUTH MODE ACTIVE:",
  "- Explicitly surface uncertainty when present.",
  "- Hedge claims that aren't directly supported by retrieval context (prefer \"the source suggests\" or \"based on the available material\" over \"it is\").",
  "- When you cite [N], the citation must point to a chunk you actually used.",
  "- If you don't know, say \"I don't know\" instead of speculating.",
  "- Do not invent citations or sources.",
].join("\n");

interface CitedHit {
  index: number;
  text: string;
  filename: string;
  chunkIndex: number;
  score: number;
  /** Phase 3: bucketed confidence — "high" | "medium" | "low" */
  confidence: Confidence;
  docId: string;
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error, ...extra }, { status });
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || /aborted|abort/i.test(e.message))
  );
}

function isConnRefused(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  return /ECONNREFUSED|fetch failed|other side closed|ENOTFOUND/i.test(msg);
}

/** v2.4.2 Phase A — replay a complete (non-streamed) Nous answer as a single
 *  Ollama-shaped NDJSON content frame + a final done frame. The existing stream
 *  reader/accumulator path then handles the Nous response IDENTICALLY to a local
 *  Ollama stream — same wire format to the client, same downstream integrity
 *  evaluation. */
function makeSyntheticReader(
  content: string
): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  const rs = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        enc.encode(JSON.stringify({ message: { content }, done: false }) + "\n")
      );
      c.enqueue(enc.encode(JSON.stringify({ done: true }) + "\n"));
      c.close();
    },
  });
  return rs.getReader();
}

function lastUserText(msgs: WireMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].content;
  }
  return null;
}

/** The user message BEFORE the most recent one — the query for an explicit
 *  "go look it up" request, whose literal text isn't the thing to search. */
function priorUserText(msgs: WireMessage[]): string | null {
  let seenLast = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    if (seenLast) return msgs[i].content;
    seenLast = true;
  }
  return null;
}

// Canon regression fix Option E (2026-05-28). When Bart is asked about
// a canon character by name, suppress vault retrieval entirely for
// that turn — the vault was actively misleading the model on these
// queries (top-N chunks rarely surface character-specific content,
// and the model confabulated identities by stitching unrelated
// retrieval tokens together). Bart's system prompt already carries
// the canon block; with retrieval off he leans on it directly.
//
// Operational queries (anything without a canon name) still use the
// vault normally. All other personas always use the vault per their
// own retrieval defaults.
const BART_CANON_NAMES = [
  "faquarl",
  "jabor",
  "nouda",
  "queezle",
  "nathaniel",
  "mandrake",
  "kitty",
  "ptolemy",
  "lovelace",
  "harlequin",
  "simpkin",
  "honorius",
];

function isCanonQuery(personaId: string, message: string): boolean {
  if (personaId !== "bartimaeus") return false;
  const lower = message.toLowerCase();
  // Word-boundary match keeps "kitty" from triggering on "kitty-corner"
  // or similar. Anchors on \b which handles punctuation + spaces.
  return BART_CANON_NAMES.some((name) => {
    const re = new RegExp(`\\b${name}\\b`, "i");
    return re.test(lower);
  });
}

// Phase 10 — research context block. Sits between memory and vault
// in the system prompt. Format mirrors buildRetrievalBlock so the
// model parses it consistently.
function buildResearchBlock(r: ResearchReport): string {
  const lines: string[] = [];
  const ageNote = r.cachedAt
    ? ` (cached; generated ${r.cachedAt})`
    : "";
  lines.push(
    `[RESEARCH CONTEXT — ${r.intent} — Quality: ${r.quality} — Confidence: ${r.confidenceScore.toFixed(2)}${ageNote}]`
  );
  lines.push(`Summary: ${r.summary}`);
  if (r.findings.length > 0) {
    lines.push("Key findings:");
    for (const f of r.findings) lines.push(`- ${f}`);
  }
  if (r.conflicts.length > 0) {
    lines.push("Conflicts flagged:");
    for (const c of r.conflicts) lines.push(`- ${c}`);
  }
  if (r.citations.length > 0) {
    lines.push("Sources:");
    for (const c of r.citations) lines.push(c);
  }
  lines.push("[/RESEARCH CONTEXT]");
  return lines.join("\n");
}

function buildRetrievalBlock(hits: RetrievalHit[]): string {
  const lines = hits.map((h, i) => {
    const idx = i + 1;
    const cleaned = h.text.replace(/\s+/g, " ").trim();
    return `[${idx}] ${cleaned} (source: ${h.filename}, chunk ${h.chunkIndex})`;
  });
  // Canon regression fix (2026-05-28). Original wrapper said "If no
  // chunk is relevant, say so plainly and do not invent citations."
  // The model read that as "vault is authoritative for what exists"
  // and started refusing to discuss canon characters (Faquarl, Jabor,
  // etc.) whenever the top-N retrieved chunks didn't contain their
  // names. Broke Bart's canon identity directive in the deployed
  // config (where retrieval defaults on for Bart).
  //
  // New wrapper: vault is advisory, not authoritative. Personas keep
  // their own knowledge + memory; vault supplements. The no-fabricated-
  // citations contract stays intact.
  return [
    "RELEVANT CONTEXT (supplementary vault excerpts — cite as [1], [2] only when you actually use them):",
    ...lines,
    "",
    "This material supplements your own knowledge and memory. When the vault doesn't cover what the user asked, answer from your own knowledge — do NOT claim a topic or character doesn't exist just because it's absent from these excerpts. Cite [N] only when you use vault material; never invent citations.",
  ].join("\n");
}

export async function POST(req: NextRequest) {
  // Phase 11 — bump the in-flight counter so the scheduler skips
  // ticking while a chat is being processed. Decremented in the
  // stream's close/cancel/error paths AND in every early-return
  // below. Once streamingStarted=true the stream owns the decrement.
  beginInFlight();
  // Local wrapper: every `return jsonError(...)` becomes
  // `return abort(...)` so the counter decrements on every error
  // exit. Streaming success path skips this and lets the stream's
  // close handler decrement.
  const abort = (
    ...args: Parameters<typeof jsonError>
  ) => {
    endInFlight();
    // BUGFIX (Phase 9, 2026-05-31): this previously called `abort(...args)`
    // — itself — which infinitely recursed and stack-overflowed on EVERY
    // error-return path (the happy path never hits abort, which is why
    // smokes passed). Must delegate to jsonError, which builds the actual
    // Response. The endInFlight() above keeps the Phase 11 in-flight
    // counter balanced on error exits.
    return jsonError(...args);
  };

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return abort(400, "invalid JSON body");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return abort(400, "messages must be a non-empty array");
  }
  if (body.messages.length > MAX_MESSAGES) {
    return abort(400, `too many messages (max ${MAX_MESSAGES}, got ${body.messages.length})`);
  }
  // Per-message validation: role + content type + content length.
  // Catches malformed clients before they hit the daemon.
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!m || typeof m !== "object") {
      return abort(400, `messages[${i}] must be an object`);
    }
    if (typeof m.role !== "string" || !VALID_ROLES.has(m.role as WireRole)) {
      return abort(400, `messages[${i}].role must be one of user|assistant|system`);
    }
    if (typeof m.content !== "string") {
      return abort(400, `messages[${i}].content must be a string`);
    }
    if (m.content.length > MAX_CONTENT_LENGTH) {
      return abort(
        400,
        `messages[${i}].content exceeds ${MAX_CONTENT_LENGTH} chars (got ${m.content.length})`
      );
    }
    // Vision Phase 1 — validate optional images array (defensive bounds).
    if (m.images !== undefined) {
      if (!Array.isArray(m.images)) {
        return abort(400, `messages[${i}].images must be an array of base64 strings`);
      }
      if (m.images.length > MAX_IMAGES_PER_MESSAGE) {
        return abort(
          400,
          `messages[${i}].images exceeds ${MAX_IMAGES_PER_MESSAGE} images (got ${m.images.length})`
        );
      }
      for (let j = 0; j < m.images.length; j++) {
        const img = m.images[j];
        if (typeof img !== "string" || img.length === 0) {
          return abort(400, `messages[${i}].images[${j}] must be a non-empty base64 string`);
        }
        if (img.length > MAX_IMAGE_CHARS) {
          return abort(
            400,
            `messages[${i}].images[${j}] exceeds the ${(MAX_IMAGE_CHARS / 1024 / 1024).toFixed(0)} MB image limit`
          );
        }
      }
    }
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return abort(400, "model is required");
  }
  // v1.1: allowed list = static AVAILABLE_MODELS + Power Mode additions.
  // Operator can declare extra models via config/persona-overrides.json
  // without source-code changes when running on better hardware.
  const overrideModels = await getAvailableModelsAdditions();
  const effectiveAllowed = [...AVAILABLE_MODELS, ...overrideModels];
  if (!isAvailableModel(body.model) && !overrideModels.includes(body.model)) {
    return abort(400, `model not in allowed list: ${body.model}`, {
      availableModels: effectiveAllowed,
    });
  }
  // v1.1: resolve persona with config overrides applied. Static
  // PERSONA_BY_ID still drives identity (name, color, prompt); only
  // model + status + intendedModel can be overridden via
  // config/persona-overrides.json.
  let persona;
  try {
    persona = await resolvePersona(body.personaId);
  } catch {
    return abort(400, `unknown persona: ${String(body.personaId)}`);
  }
  if (!persona) {
    return abort(400, `unknown persona: ${String(body.personaId)}`);
  }
  // Phase 2-RB: refuse to dispatch a chat for a persona whose model
  // isn't wired. Doctrine: never fake a model-backed persona; let the
  // UI render an honest "not configured" state instead of a vague
  // 404 from Ollama. The store's switchPersona already blocks the UI
  // path; this is the API-level enforcement.
  if (!isPersonaSelectable(persona)) {
    return abort(
      503,
      `persona "${persona.name}" is not configured (no validated model wired)`,
      {
        hint: persona.intendedModel
          ? `Install ${persona.intendedModel} into Ollama and re-bind in lib/personas.ts, or pick a different persona.`
          : `No intended model recorded. Pick a different persona.`,
      }
    );
  }

  // ---- Inference backend + rebound-model resolution (v2.4.2 Phase A) ----
  // Read settings ONCE here (reused for the auth gate below — no second disk
  // read). Two INDEPENDENT axes:
  //   - useReboundModels: a LOCAL model swap (Juniper/Bobby → gemma-4) that must
  //     feed resolveChatModel below, so the rebound model is what actually runs
  //     AND what the audit logs. Default off → models run unchanged.
  //   - requestedBackend: local Ollama vs the Nous free tier, resolved per
  //     persona. The Nous CALL happens later (after the message list is built).
  const settings = await readSettings().catch(() => null);
  const useReboundModels = settings?.useReboundModels === true;
  const reboundLocalModel = resolveLocalModel(
    body.personaId,
    body.model,
    useReboundModels
  );
  const requestedBackend = resolveBackend(body.personaId, settings);
  // Gate 2 (2026-06-09) — cloud data policy for THIS persona. "redacted"
  // (default) strips local-data system segments before any Nous call. Resolved
  // here; applied only if the turn actually takes the Nous path below.
  const cloudPolicy = resolveCloudDataPolicy(body.personaId, settings);

  // ---- Vision routing (2026-06-02) ----
  // If any message carries an image, route this turn to the multimodal model
  // (gemma4-turbo) instead of the persona's text model. The persona system
  // prompt is still injected below, so the analysis returns in-character —
  // only the MODEL changes. Text-only turns are unaffected. The rebound model
  // (when the flag is on) is the LOCAL model fed here; vision routing overrides
  // it for image turns regardless.
  const hasImages = messagesHaveImages(body.messages);
  // `let`: the tool-execution model routing below (after toolsEnabled is
  // known) may override this for an explicit tool turn — same per-turn
  // model-swap seam as vision. Vision wins on image turns (resolved here
  // first; tool routing is gated on toolsEnabled, which excludes vision).
  const { model: visionRoutedModel, vision: visionTurn } = resolveChatModel({
    hasImages,
    personaModel: reboundLocalModel,
  });
  let effectiveModel = visionRoutedModel;
  if (visionTurn) {
    console.info(
      `[chat] vision turn — routing to ${effectiveModel} (persona ${body.personaId} stays in voice)`
    );
  }

  // ---- Retrieval (graceful: never breaks the chat) ----
  // Phase 3: persona's retrieval config supplies defaults when request
  // body doesn't override. Explicit body fields still win — operator can
  // force retrieval on a normally-no-retrieval persona (Bobby/Juniper),
  // or bump topK above persona default, or disable on Bart/Sage.
  //
  // Canon regression fix Option E (2026-05-28): if Bart is asked about
  // a canon character by name (Faquarl, Jabor, Nouda, etc.), force-
  // suppress retrieval for this turn even if the operator had it on.
  // The vault was actively misleading the model on these queries —
  // see isCanonQuery + BART_CANON_NAMES above.
  const requestedRetrieval =
    body.useRetrieval !== undefined
      ? body.useRetrieval !== false
      : persona.retrieval.defaultEnabled;
  const canonHit = isCanonQuery(
    body.personaId,
    lastUserText(body.messages) ?? ""
  );
  const wantsRetrieval = requestedRetrieval && !canonHit;
  if (canonHit && requestedRetrieval) {
    // Operator-visible diagnostic — appears in server logs when the
    // suppression fires. The audit chain doesn't record this
    // currently; consider adding a "retrieval.suppressed" event kind
    // if forensic visibility becomes important.
    console.info(
      `[chat] canon-name suppression: bartimaeus query matched a canon name → retrieval skipped this turn`
    );
  }
  const topK =
    typeof body.topK === "number" && body.topK > 0 && body.topK <= 50
      ? body.topK
      : persona.retrieval.topK ?? DEFAULT_TOP_K;
  const minConfidence = persona.retrieval.minConfidence;

  let retrievedHits: RetrievalHit[] = [];
  let retrievalError: string | null = null;
  const queryText = wantsRetrieval ? lastUserText(body.messages) : null;
  if (wantsRetrieval && queryText) {
    try {
      retrievedHits = await retrieve(queryText, topK, { minConfidence });
    } catch (e) {
      retrievalError = e instanceof Error ? e.message : String(e);
      console.warn(`[chat] retrieval failed, continuing without context: ${retrievalError}`);
    }
  }

  // ---- Operator Auth (2026-05-28): two-mode chat ----
  // Server-side decision tree:
  //   settings.requirePin === false → always operator (pre-auth behavior)
  //   settings.requirePin === true  → look for Authorization: Bearer
  //                                   - valid token in store → operator
  //                                   - missing / invalid → guest
  // Guest mode: persona.guestSystemPrompt (generic register, refuses
  // internal project context), NO memory injection. Vault retrieval
  // is left intact because vault content is operator-uploaded
  // documents; the operator's own materials don't change between
  // modes.
  // v2.4.2 Phase A — reuse the settings already read above (single disk read).
  const requirePin = settings?.requirePin === true;
  const bearer = parseBearer(req.headers.get("authorization"));
  const isOperator = !requirePin || isTokenValid(bearer);

  // ---- Memory retrieval (Phase 9, graceful: never breaks chat) ----
  // Order: persona prompt → memory context → vault retrieval → truth.
  // Memory injection sits between persona and vault per the Phase 9
  // directive so a persona's character framing comes first, then the
  // operator-specific memory, then the document-specific retrieval.
  // Operator Auth: only runs when isOperator === true.
  let memoryBlock = "";
  const userText = lastUserText(body.messages) ?? "";
  if (isOperator && userText) {
    try {
      memoryBlock = await retrieveMemoriesForPrompt(
        body.personaId as MemoryPersonaScope,
        userText
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chat] memory retrieval failed, continuing without context: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  // ---- Semantic cross-session recall (Memory Phase, graceful) ----
  // Keyword/category match over operator_facts.jsonl + MEMORY.md tail. The
  // resulting block is PREPENDED to the system prompt (before the persona
  // prompt) so Bartimaeus carries forward what the operator told him in past
  // sessions — naturally, without announcing it. Operator turns only.
  let recall = { factsFound: 0, injected: false, block: "" };
  if (isOperator && userText) {
    try {
      const r = await retrieveMemories(userText);
      recall = { factsFound: r.factsFound, injected: r.injected, block: r.block };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chat] semantic recall failed, continuing without it: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  // ---- Phase 10 research (graceful: never breaks chat) ----
  // Only fires for operator turns. Guest turns get no research
  // context — keeps the network-mode boundary clean (guest = local
  // only). Failures degrade to "no research block" silently.
  let researchReport: ResearchReport | null = null;
  // Vision turns skip research — the intent is "analyze this image", not a
  // web-research query; running the research planner on it wastes latency.
  if (isOperator && userText && !visionTurn) {
    try {
      researchReport = await runResearch(userText, body.personaId);
      if (researchReport) {
        // Phase 11 — fire-and-forget post-hook (memory + alerts).
        // Doesn't block the response; we don't await the resulting
        // promise either, since chat shouldn't wait on Pushover.
        void afterReport(
          researchReport,
          body.personaId as MemoryPersonaScope
        ).catch((e) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[chat] afterReport hook failed (non-fatal): ${
              e instanceof Error ? e.message : String(e)
            }`
          );
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chat] research pipeline failed (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  // ---- System prompt construction ----
  // Auth-gated: guest sees persona.guestSystemPrompt; operator sees
  // persona.systemPrompt (the full character register).
  //
  // Order (operator mode): persona → memory → research → vault → truth.
  // Research goes BETWEEN memory and vault per the Phase 10 directive:
  // memory is who-the-operator-is, research is what-the-world-says,
  // vault is what-the-operator's-own-docs-say. Composition order
  // matters for how the model weighs them.
  const baseSystemPrompt = isOperator
    ? persona.systemPrompt
    : persona.guestSystemPrompt;
  // Memory Phase: semantic recall PREPENDS the persona prompt — additive,
  // never a replacement. The block is short (≤300 chars) and tells the model
  // to use the context naturally without announcing it.
  // Gate 2 (2026-06-09) — labeled system segments. Each push records a label
  // and a `sensitive` flag so the Nous egress guard can strip local-data
  // segments (vault chunks, memory facts, prior tool results) on a "redacted"
  // turn while keeping identity/voice/instructions. The LOCAL path is byte-for-
  // byte unchanged: systemPrompt is still `parts.map(text).join("\n\n")` in
  // push order. `sensitive` = "this segment carries operator-private local data
  // that must not leave the box under the redacted policy."
  const systemParts: string[] = [];
  const partMeta: Array<{ label: string; sensitive: boolean }> = [];
  const addPart = (text: string, label: string, sensitive = false): void => {
    systemParts.push(text);
    partMeta.push({ label, sensitive });
  };
  if (recall.injected && recall.block) {
    addPart(recall.block, "memory:recall", true);
  }
  addPart(baseSystemPrompt, "persona:identity", false);
  // Register calibration (2026-06-02) — Bartimaeus is brief by default. Keeps
  // operational replies tight; depth is on demand via /deep. Operator turns
  // only (guests get the generic register).
  if (isOperator && body.personaId === "bartimaeus") {
    addPart(
      [
        "REGISTER RULES:",
        "- Operational/factual exchanges: 2-3 sentences. Answer first. Wit second. Never third.",
        "- When corrected: acknowledge with one dry line, then correct course. No defense. No lecture.",
        "- Tool results: state the answer in one sentence. One optional observation. Done.",
        "- Deep philosophical or strategic questions: full response, no limit. The operator signals depth with /deep.",
        "- Default assumption: the operator wants the answer, not the architecture of the answer.",
        "- You are sardonic, not verbose. Precision means fewer words, not more.",
        "- If the operator tells you to dial it back, stop the banter immediately — minimal answers until told otherwise.",
      ].join("\n"),
      "register:bart",
      false
    );
  }
  // Tools Phase — tool awareness (operator turns only; guests never get tools;
  // skipped on vision turns where the model is gemma4).
  // v2.3.11 — persona tool DISTRIBUTION: each conversational persona gets a
  // ROLE-SCOPED subset (Bart = all; Sage = research; Bobby = ops; Juniper =
  // comms). The subset is enforced at execution below, so the distribution is
  // real, not advisory.
  const personaToolIds = toolsForPersona(persona.id, KNOWN_TOOL_IDS);
  const toolsEnabled = isOperator && !visionTurn && personaToolIds.length > 0;
  // ---- Tool-execution model routing (2026-06-09) ----
  // When the operator EXPLICITLY commands a tool this turn, route the turn to
  // the dedicated tool-emission model (settings.toolExecutionModel, default
  // hermes3:8b — 3/3 clean in the round-2 emission harness vs 1/3 for the
  // best persona model; scripts/harness-evidence.jsonl). Same seam as vision:
  // only the MODEL changes — the persona prompt is still injected, so the
  // answer stays in character. The trigger is isExplicitToolRequest — the
  // detector the integrity guard already trusts (no new classifier). Implicit
  // mid-conversation tool use stays on the persona model; the prompt schema +
  // the file_ops "action" alias cover that path.
  const toolExecutionModel = settings?.toolExecutionModel ?? "";
  const toolModelTurn =
    toolsEnabled &&
    toolExecutionModel.length > 0 &&
    isExplicitToolRequest(userText, KNOWN_TOOL_IDS);
  if (toolModelTurn) {
    effectiveModel = toolExecutionModel;
    console.info(
      `[chat] explicit tool turn — routing to ${effectiveModel} (persona ${body.personaId} stays in voice)`
    );
  }
  // v2.3.9 — tool results the operator already saw on the most recent assistant
  // turn. The /api/chat wire history now carries them (ChatPane). They are used
  // two ways: surfaced to the model so it HAS the outcome in context (root cause
  // of "I await the result" was that it never did), and fed to the
  // misrepresentation guard after generation (backstop).
  const priorToolResults: ToolResultLike[] = (() => {
    const prevAssistant = [...body.messages].reverse().find((m) => m.role === "assistant");
    const trs = (prevAssistant as WireMessage | undefined)?.toolResults;
    return Array.isArray(trs) ? (trs as ToolResultLike[]) : [];
  })();
  const priorNegatives = priorToolResults.filter(isNegativeStateResult);
  // Tool results computed THIS turn (model-initiated or forced). Also fed to the
  // misrepresentation guard so a same-turn continuation can't soften them.
  const turnToolResults: ToolResultLike[] = [];
  if (toolsEnabled) {
    // Bart gets the full rich source-routing guidance; scoped personas get a
    // concise block listing ONLY their subset.
    addPart(
      buildToolAwarenessBlock(persona.id === "bartimaeus" ? undefined : personaToolIds),
      "tools:awareness",
      false
    );
    // v2.3.9 — surface the most recent COMPLETED tool results so the model
    // reports them faithfully and cannot honestly claim to be "awaiting" a
    // result that is already in its context. SENSITIVE: prior tool results can
    // carry file contents (file_ops read) or other local data — stripped on a
    // redacted Nous turn.
    if (priorToolResults.length > 0) {
      addPart(buildRecentToolResultsBlock(priorToolResults), "tool_results:prior", true);
    }
    // Next-turn corrective injection (v2.3.8 doctrine, Layer 1 §5 + Layer 2 §4;
    // v2.3.9 §7 adds the misrepresentation correction).
    // If the PRIOR assistant turn emitted a tool call the parser could not
    // execute, OR was flagged as an integrity violation, tell the model plainly
    // so it does not claim — or defend — a phantom result this turn.
    try {
      const priorAssistant =
        [...body.messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
      if (priorAssistant) {
        const priorParse = parseToolCalls(priorAssistant);
        if (priorParse.calls.length === 0 && priorParse.failures.length > 0) {
          addPart(PARSE_FAILURE_SYSTEM_NOTE, "integrity:parse_failure_note", false);
        }
        if (/MISREPRESENTATION/i.test(priorAssistant)) {
          // The prior turn softened a completed negative result. Correct it with
          // the actual outcome (from the results the operator saw). SENSITIVE:
          // embeds a prior tool-result summary — stripped on a redacted turn.
          const sum = (priorNegatives[0]?.summary ?? "a negative result").toString();
          addPart(buildMisrepCorrectionNote(sum), "tool_results:misrep_correction", true);
        } else if (/INTEGRITY VIOLATION|INTEGRITY WARNING/i.test(priorAssistant)) {
          addPart(FABRICATION_SYSTEM_NOTE, "integrity:fabrication_note", false);
        }
      }
    } catch {
      /* corrective injection is best-effort */
    }
  }
  // FORCED current-facts grounding. For time-sensitive queries we don't trust
  // Bart to choose to call web_search — we run it server-side now and inject
  // the fresh results as authoritative context, overriding stale training data.
  // Graceful: a failed/empty search just skips the block (normal flow resumes).
  // Did ANY tool run/route this turn (forced current-facts tool OR a model-
  // initiated, parsed call)? The integrity guard uses this to decide whether a
  // tool-use claim in the final answer is backed by a real execution.
  let toolRanThisTurn = false;
  // v2.3.11 — set when the model emits a malformed tool tag (parse failure) this
  // turn; feeds the integrity guard's structural check.
  let toolParseFailedThisTurn = false;
  // FORCED grounding stays Bartimaeus-only — it server-side-invokes web_search/
  // chain_search_to_read/open_meteo_weather, which not every persona holds.
  // Scoped personas reach those tools via the normal model-initiated path.
  if (toolsEnabled && persona.id === "bartimaeus" && userText) {
    const cf = detectCurrentFacts(userText);
    if (cf.isCurrentFacts) {
      try {
        // Resolve the query: an explicit "go look it up" uses the PRIOR user
        // message (the thing to research), not the literal command.
        let query = cf.suggestedQuery;
        if (cf.usePriorMessage) {
          const prior = priorUserText(body.messages);
          if (prior) query = prior;
        }
        const toolCtx = { sessionId: null, personaId: "bartimaeus", model: effectiveModel };
        // Track whether grounding was actually injected. If the forced tool
        // fails/returns nothing, we inject a GUARD block forbidding Bart from
        // answering from (stale) training data — so he can't hallucinate a
        // plausible-but-wrong answer (the "Michael Levy" CEO bug).
        let grounded = false;
        if (cf.suggestedTool === "open_meteo_weather" && cf.location) {
          // Weather → structured Open-Meteo forecast (replaces the DDG hack).
          const outcome = await requestTool("open_meteo_weather", { location: cf.location }, toolCtx);
          if (outcome.kind === "result" && outcome.result.ok) {
            // Forced grounding = CURRENT-turn public web/weather data the model
            // needs to answer THIS query — not operator-private local data. Kept
            // on a redacted Nous turn (stripping it would force a hallucinated
            // answer). See egress note in the report; flagged as a judgment call.
            addPart(buildWeatherBlock(outcome.result), "grounding:weather", false);
            grounded = true;
            toolRanThisTurn = true; // a forced tool ran this turn
          }
        } else if (cf.suggestedTool === "chain_search_to_read") {
          // Entity / company / events → chain searches AND reads the pages,
          // so "who is the CEO of X" gets real content, not shallow snippets.
          const outcome = await requestTool("chain_search_to_read", { query }, toolCtx);
          if (outcome.kind === "result" && outcome.result.ok) {
            addPart(buildChainBlock(cf, outcome.result), "grounding:chain", false);
            grounded = true;
            toolRanThisTurn = true; // a forced tool ran this turn
          }
        } else {
          const outcome = await requestTool(
            "web_search",
            { query, limit: 5 },
            toolCtx
          );
          if (outcome.kind === "result" && outcome.result.ok) {
            addPart(buildCurrentFactsBlock(cf, outcome.result), "grounding:current_facts", false);
            grounded = true;
            toolRanThisTurn = true; // a forced tool ran this turn
          }
        }
        if (!grounded) {
          addPart(buildNoGroundingBlock(cf), "grounding:none", false);
        }
      } catch {
        /* graceful — no grounding block; Bart's normal tool flow still applies */
      }
    }
  }
  if (memoryBlock.length > 0) {
    // SENSITIVE: cross-session operator memory facts.
    addPart(memoryBlock, "memory:facts", true);
  }
  if (researchReport) {
    // Research = public web research the system performed (Phase 10/11), not
    // operator-private local data. Kept on a redacted turn; flagged as a
    // judgment call in the report alongside grounding.
    addPart(buildResearchBlock(researchReport), "research:report", false);
  }
  if (retrievedHits.length > 0) {
    // SENSITIVE: vault retrieval chunks — operator documents. Stripped on a
    // redacted Nous turn.
    addPart(buildRetrievalBlock(retrievedHits), "vault:retrieval", true);
  }
  if (body.truthMode === true) {
    addPart(TRUTH_MODE_CLAUSE, "truth_mode", false);
  }
  // Conversational-memory reminder, pushed LAST so it's the final system
  // content immediately before the message thread — maximum recency. Belt-and-
  // braces: Bart's former model (royhodge812/Orchestrator) reflexively denied
  // having memory; the gemma-4 swap (2026-06-02) fixed that, but this reminder
  // stays as cheap defense-in-depth for any model. Only applied to a MULTI-TURN
  // session (≥2 user turns) so it never fires on a fresh first message; short +
  // general, harmless to personas that already handle context.
  {
    const userTurns = body.messages.filter((m) => m.role === "user").length;
    if (userTurns >= 2) {
      // Instruction about the thread (always sent), not local data — not sensitive.
      addPart(
        "CONVERSATION MEMORY: The full message thread below is visible to you. " +
          "If the operator asks what they (or you) said, asked, or established earlier in " +
          "this conversation, read the messages and answer from them. NEVER claim the " +
          "operator hasn't told you something that is present in the thread, and never " +
          "recite an \"I have no memory of past interactions\" disclaimer — it is false here.",
        "memory:conversation_reminder",
        false
      );
    }
  }
  const systemPrompt = systemParts.join("\n\n");

  // ---- Response-length governance (2026-06-02) ----
  // Bartimaeus is brief by default (a max-tokens cap via Ollama's num_predict).
  // The operator can request a long answer by leading their message with
  // "/deep" — that lifts the cap to 2000 and the prefix is stripped before the
  // model ever sees it. The cap applies to Bartimaeus TEXT turns only: Sage and
  // the other personas stay long-form, and vision turns run uncapped so image
  // analysis isn't truncated.
  let lastUserIdx = -1;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const deepMode =
    lastUserIdx >= 0 && /^\s*\/deep\b/i.test(body.messages[lastUserIdx].content);
  // Bart is brief by default — register calibration keeps standard replies
  // tight (250 tokens). /deep lifts the cap to 2000 for genuine depth.
  const DEFAULT_MAX_TOKENS = 250;
  const maxTokens =
    body.personaId === "bartimaeus" && !visionTurn
      ? deepMode
        ? 2000
        : DEFAULT_MAX_TOKENS
      : null;

  // Build the Ollama message list. Vision Phase 1: when a user turn carries
  // images, attach them as Ollama's native `images: [base64]` field (data-URL
  // prefixes stripped). The "/deep" prefix is stripped from the current user
  // turn so the model never sees the command token.
  const ollamaMessages: Array<{
    role: WireRole;
    content: string;
    images?: string[];
  }> = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m, i) => {
      const content =
        i === lastUserIdx && deepMode
          ? m.content.replace(/^\s*\/deep\b[ \t]*/i, "")
          : m.content;
      return m.images && m.images.length > 0
        ? { role: m.role, content, images: m.images.map(stripDataUrl) }
        : { role: m.role, content };
    }),
  ];

  // ---- Inference backend switch (v2.4.2 Phase A) ----
  // Resolve WHERE this turn runs. Default (requestedBackend === "local") leaves
  // the Ollama path below byte-for-byte unchanged. On the "nous" path we make a
  // single NON-STREAMED POST to nvidia/nemotron-3-ultra:free; ANY failure (no
  // key, non-2xx, timeout, empty) falls back to local SILENTLY and records the
  // literal reason — the operator never sees an error. Vision turns are always
  // local (the multimodal model is local-only). The answered backend + EXACT
  // model are logged at stream close; never a generic "nous" label.
  const inferenceStart = Date.now();
  let answeredBackend: "local" | "nous" = "local";
  let answeredModel = effectiveModel;
  let fallbackReason: string | null = null;
  let nousResult: NousResult | null = null;

  const controller = new AbortController();
  const firstTokenTimer = setTimeout(() => {
    controller.abort();
  }, FIRST_TOKEN_TIMEOUT_MS);

  if (requestedBackend === "nous" && visionTurn) {
    fallbackReason = "vision_turn_local_only";
  } else if (requestedBackend === "nous" && toolModelTurn) {
    // Tool reliability is the entire point of the tool-model route — Nemotron
    // emits native OpenAI tool_calls, which ARGOS does not read. Explicit tool
    // turns stay local on the tool model; the reason is audited honestly.
    fallbackReason = "tool_turn_local_only";
  } else if (requestedBackend === "nous") {
    const nousKey = settings?.nousApiKey
      ? await decryptSecret(settings.nousApiKey).catch(() => null)
      : null;
    if (!nousKey) {
      fallbackReason = "nous_key_missing";
    } else {
      // ---- Egress guard (Gate 2, 2026-06-09) ----
      // On a "redacted" turn, strip the SENSITIVE system segments (vault chunks,
      // memory facts, prior tool results) before the cloud call. Identity/voice,
      // tool-awareness, register, grounding and the user thread still go — the
      // persona answers in character, just without local-data leakage. "full"
      // sends the byte-identical original prompt (explicit per-persona opt-in).
      let nousSystemContent = systemPrompt;
      if (cloudPolicy === "redacted") {
        const kept: string[] = [];
        const strippedLabels: string[] = [];
        let bytesWithheld = 0;
        for (let i = 0; i < systemParts.length; i++) {
          if (partMeta[i].sensitive) {
            strippedLabels.push(partMeta[i].label);
            bytesWithheld += Buffer.byteLength(systemParts[i], "utf8");
          } else {
            kept.push(systemParts[i]);
          }
        }
        nousSystemContent = kept.join("\n\n");
        if (strippedLabels.length > 0) {
          // Audit the redaction with COUNTS + LABELS only — never the stripped
          // content itself (that would defeat the guard's whole purpose).
          await appendAudit("chat.egress_redaction", {
            persona: body.personaId,
            backend: "nous",
            policy: cloudPolicy,
            segments_stripped: strippedLabels.length,
            labels_stripped: strippedLabels,
            labels_kept: partMeta.filter((m) => !m.sensitive).map((m) => m.label),
            bytes_withheld: bytesWithheld,
            vault_chunks_stripped: retrievedHits.length,
            memory_facts_injected: recall.factsFound,
            prior_tool_results_stripped: priorToolResults.length,
          }).catch(() => {
            /* audit is the receipt, never the gate */
          });
        }
      }
      // Rebuild the message list with the (possibly redacted) system content at
      // index 0; user/assistant turns are passed through unchanged.
      const nousMessages = ollamaMessages.map((m, i) => ({
        role: m.role,
        content: i === 0 ? nousSystemContent : m.content,
      }));
      try {
        nousResult = await callNous({
          apiKey: nousKey,
          messages: nousMessages,
          maxTokens,
        });
        answeredBackend = "nous";
        answeredModel = nousResult.model; // EXACT echoed id — logged verbatim
      } catch (e) {
        // Silent fallback to local (doctrine). Record the literal reason.
        fallbackReason = `nous_error: ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
    }
  }

  // ---- Open the response source: synthetic (Nous) OR the Ollama stream ----
  let upstream: Response | null = null;
  if (nousResult) {
    // Nous already returned the full answer; there's no upstream stream to open.
    clearTimeout(firstTokenTimer);
  } else {
    try {
      // v1.1 Task 2: per-persona `think` flag (was hardcoded `false`).
      // Default is `false` if persona doesn't declare — preserves the
      // Phase 2-RB doctrine for safety on gemma4/qwen3-thinking models
      // (they emit ALL output via message.thinking + zero into
      // message.content when think:true). Each persona sets this
      // explicitly in lib/personas.ts; see MODELS.md for which models
      // require which.
      // Vision Phase 1: force think:false on vision turns — gemma4-turbo is a
      // gemma4 model that emits ALL output via message.thinking (and nothing
      // into message.content) when think:true. Text turns keep the persona flag.
      const personaThink = !visionTurn && persona.think === true;
      upstream = await fetch(OLLAMA_CHAT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: effectiveModel,
          messages: ollamaMessages,
          stream: true,
          think: personaThink,
          // The operator is mid-conversation with this persona — keep it warm so
          // the next message doesn't cold-load. Background calls (extractor, etc.)
          // use a short keep_alive so they can't evict it (keep-alive coordination).
          keep_alive: KEEP_ALIVE_CONVERSATIONAL,
          // Ollama's num_predict is the response token cap. Brief by default for
          // Bartimaeus; /deep lifts it to 2000; null = uncapped (Sage, vision).
          options: {
            think: personaThink,
            ...(maxTokens != null ? { num_predict: maxTokens } : {}),
          },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(firstTokenTimer);
      if (isAbortError(e)) {
        return abort(504, "Ollama did not respond within 60s (first-token timeout)");
      }
      if (isConnRefused(e)) {
        return abort(
          503,
          `Ollama not reachable at ${OLLAMA_BASE}. Is \`ollama serve\` running?`
        );
      }
      return abort(502, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!upstream.ok) {
      clearTimeout(firstTokenTimer);
      const errBody = await upstream.text();
      if (upstream.status === 404 || /not found|no such model/i.test(errBody)) {
        return abort(404, `model not found: ${effectiveModel}`, {
          hint: visionTurn
            ? `Vision model missing. Run: ollama pull ${effectiveModel}`
            : `Run: ollama pull ${effectiveModel}`,
          ollamaBody: errBody,
        });
      }
      return abort(upstream.status, `ollama error ${upstream.status}`, {
        ollamaBody: errBody,
      });
    }
    if (!upstream.body) {
      clearTimeout(firstTokenTimer);
      return abort(502, "empty stream body from Ollama");
    }
  }

  // Build the retrieval event we'll emit after Ollama closes.
  const citedHits: CitedHit[] = retrievedHits.map((h, i) => ({
    index: i + 1,
    text: h.text,
    filename: h.filename,
    chunkIndex: h.chunkIndex,
    score: h.score,
    confidence: h.confidence,
    docId: h.docId,
  }));
  const retrievalEvent = {
    type: "retrieval" as const,
    hits: retrievalError === null ? citedHits : null,
    error: retrievalError,
    enabled: wantsRetrieval,
  };

  // Phase 10 — research event. Mirrors retrievalEvent shape so the
  // client can render the HUD Research row from a single ndjson tail
  // frame. `state` drives the HUD label:
  //   OFF      — research wasn't attempted (non-research turn / guest)
  //   LIVE     — fresh research, served from network this turn
  //   CACHED   — served from cache (cachedAt set)
  //   FAILED   — pipeline ran but quality === FAILED
  const researchEventState: "OFF" | "LIVE" | "CACHED" | "FAILED" = (() => {
    if (!researchReport) return "OFF";
    if (researchReport.quality === "FAILED") return "FAILED";
    if (researchReport.cachedAt) return "CACHED";
    return "LIVE";
  })();
  const researchEvent = {
    type: "research" as const,
    state: researchEventState,
    intent: researchReport?.intent ?? null,
    quality: researchReport?.quality ?? null,
    confidence: researchReport?.confidenceScore ?? null,
    generatedAt: researchReport?.generatedAt ?? null,
    cachedAt: researchReport?.cachedAt ?? null,
    citationCount: researchReport?.citations.length ?? 0,
  };

  // Phase 9 (router) — persona-routing suggestion. KEYWORD-ONLY here:
  // pure CPU string scoring, sub-millisecond, NO model call → zero
  // added latency on the chat happy path. Suggestion-only: the persona
  // the user picked still answers THIS turn; we only surface a "Routing
  // to X" hint when confidence clears the gate AND it differs from the
  // current persona. Fully wrapped so a router bug can never break chat.
  let routingEvent: {
    type: "routing";
    recommended: string | null;
    confidence: number;
    currentPersona: string;
    complexity: "low" | "high";
    surface: boolean;
  };
  try {
    const r = classifyByKeyword(userText);
    routingEvent = {
      type: "routing",
      recommended: r.recommended,
      confidence: r.confidence,
      currentPersona: body.personaId,
      complexity: r.complexity,
      surface:
        r.recommended !== null &&
        r.recommended !== body.personaId &&
        r.confidence >= ROUTE_CONFIDENCE_THRESHOLD,
    };
  } catch {
    routingEvent = {
      type: "routing",
      recommended: null,
      confidence: 0,
      currentPersona: body.personaId,
      complexity: "low",
      surface: false,
    };
  }

  // Vision Phase 1 — leading frame announcing which model handled this turn
  // and whether image routing engaged. The client records it for the HUD.
  const visionEvent = {
    type: "vision" as const,
    model: effectiveModel,
    used: visionTurn,
    personaModel: body.model,
  };

  // Memory Phase — leading frame announcing how much cross-session context was
  // recalled + injected for this turn. Drives the HUD "Memory" row.
  const memoryEvent = {
    type: "memory" as const,
    factsFound: recall.factsFound,
    injected: recall.injected,
  };

  // v2.4.2 Phase A — leading frame announcing WHICH backend + EXACT model
  // answered this turn, plus any silent fallback reason. Drives a HUD row and
  // lets smokes assert the backend without parsing the whole stream.
  const backendEvent = {
    type: "backend" as const,
    backend: answeredBackend,
    model: answeredModel,
    fallbackReason,
  };

  // v2.4.2 Phase A — read from the Ollama stream OR a synthetic stream that
  // replays the Nous answer as one Ollama-shaped frame. ALL downstream work
  // (accumulate → tools → integrity → audit) is then identical for both
  // backends — the Nous response goes through the same integrity evaluation.
  const reader = nousResult
    ? makeSyntheticReader(nousResult.content)
    : upstream!.body!.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // Phase 9: accumulate assistant response in a side buffer so we can
  // run memory extraction after the stream completes. We re-decode
  // the same bytes the user receives (no extra round-trip) and parse
  // each NDJSON line in-flight to extract `message.content`. Cost is
  // a per-chunk JSON.parse — cheap relative to the stream's network
  // path. Failures here are swallowed and never surface to the user.
  let assistantBuf = "";
  let pendingLine = "";
  // v2.4.2 Phase A — capture token counts from the Ollama final ("done") frame
  // for the chat.inference audit. The Nous path supplies its own usage counts.
  let localPromptTokens: number | null = null;
  let localCompletionTokens: number | null = null;
  const accumulateContent = (chunkText: string) => {
    pendingLine += chunkText;
    let nl = pendingLine.indexOf("\n");
    while (nl !== -1) {
      const line = pendingLine.slice(0, nl).trim();
      pendingLine = pendingLine.slice(nl + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          if (parsed?.message?.content) {
            assistantBuf += parsed.message.content;
          }
          if (parsed?.done === true) {
            if (typeof parsed.prompt_eval_count === "number") {
              localPromptTokens = parsed.prompt_eval_count;
            }
            if (typeof parsed.eval_count === "number") {
              localCompletionTokens = parsed.eval_count;
            }
          }
        } catch {
          // Ignore parse failures — Ollama occasionally splits NDJSON
          // across reads; the next chunk will complete the line.
        }
      }
      nl = pendingLine.indexOf("\n");
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controllerInner) {
      // Phase 9 (router) — emit the routing suggestion as the FIRST
      // frame so the HUD can show "Routing to X" promptly (it's a hint
      // about THIS turn's query). Leading, not tail. Guarded so the
      // hint frame can never interrupt the model stream that follows.
      try {
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(routingEvent)}\n`)
        );
        // Vision Phase 1 — emit the vision frame alongside routing so the
        // HUD can show the model used as soon as the turn starts.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(visionEvent)}\n`)
        );
        // Memory Phase — emit the recall frame in the same leading batch.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(memoryEvent)}\n`)
        );
        // v2.4.2 Phase A — backend frame in the same leading batch so the HUD
        // can show which backend/model answered as soon as the turn starts.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(backendEvent)}\n`)
        );
      } catch {
        /* hint frame is best-effort; ignore */
      }
      let receivedAny = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!receivedAny) {
            receivedAny = true;
            clearTimeout(firstTokenTimer);
          }
          if (value) {
            controllerInner.enqueue(value);
            // Accumulate AFTER enqueue so the client always gets the
            // bytes first; extraction parsing is best-effort side work.
            try {
              accumulateContent(decoder.decode(value, { stream: true }));
            } catch {
              /* never let buffer parse errors interrupt the stream */
            }
          }
        }

        // ---- Tools Phase: execute a tool if Bartimaeus requested one ----
        // Bounded to ONE tool per turn. Safe tools run now and Bart continues
        // with the result; dangerous tools emit an approval request and pause
        // (the operator confirms via the dialog → /api/tools/approve). Wrapped
        // so a tool failure can NEVER break the chat stream.
        if (toolsEnabled) {
          try {
            const { calls, failures } = parseToolCalls(assistantBuf);
            // v2.3.11 — the model emitted a malformed tool tag (parse failure):
            // feed the integrity guard so a fabricated continuation after a
            // failed tool attempt is caught (the Bobby `<web_search …>` case).
            if (failures.length > 0) toolParseFailedThisTurn = true;
            // DOCTRINE (v2.3.8): a tool-call ATTEMPT is never silently lost.
            // Audit every parse failure (malformed JSON / unknown tool / orphan
            // tag) with the raw text the model emitted, and surface it.
            for (const f of failures) {
              await appendParseFailureAudit({
                raw: f.raw,
                reason: f.reason,
                toolId: f.toolId,
                sessionId: null,
                persona: body.personaId,
              });
              controllerInner.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    type: "tool_parse_failed",
                    toolId: f.toolId,
                    reason: f.reason,
                    raw: f.raw.slice(0, 400),
                  })}\n`
                )
              );
            }
            if (calls.length > 0) {
              const call = calls[0];
              // v2.3.11 — ENFORCE the persona's tool subset. A persona that
              // emits a tool OUTSIDE its scope is NOT run: it's audited and
              // surfaced as not-permitted. The tool did not run, so
              // toolRanThisTurn stays false — if the persona then claims a
              // result, the v2.3.8 fabrication guard catches it.
              if (!personaHasTool(persona.id, call.id, KNOWN_TOOL_IDS)) {
                const reason = `tool '${call.id}' is not available to persona '${persona.id}' (out of its scoped subset)`;
                await appendParseFailureAudit({
                  raw: call.raw,
                  reason,
                  toolId: call.id,
                  sessionId: null,
                  persona: body.personaId,
                });
                controllerInner.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      type: "tool_not_permitted",
                      toolId: call.id,
                      persona: persona.id,
                      reason,
                    })}\n`
                  )
                );
              } else {
                toolRanThisTurn = true; // a permitted model-initiated tool call was routed
                const outcome = await requestTool(call.id, call.params, {
                  sessionId: null,
                  personaId: body.personaId,
                  model: effectiveModel,
                });
              if (outcome.kind === "approval") {
                controllerInner.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      type: "tool_approval_required",
                      approvalId: outcome.approvalId,
                      toolId: outcome.toolId,
                      tool: outcome.toolName,
                      description: outcome.description,
                      risks: outcome.risks,
                      reversible: outcome.reversible,
                    })}\n`
                  )
                );
              } else {
                const r = outcome.result;
                // v2.3.9 — record for the misrepresentation guard so a same-turn
                // continuation cannot soften a negative result.
                turnToolResults.push({ toolId: r.toolId, ok: r.ok, summary: r.summary, data: r.data ?? null, error: r.error ?? null });
                controllerInner.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      type: "tool_result",
                      toolId: r.toolId,
                      ok: r.ok,
                      summary: r.summary,
                      data: r.data ?? null,
                      sources: r.sources ?? null,
                      error: r.error ?? null,
                    })}\n`
                  )
                );
                // Continuation: feed the result back so Bart finishes his
                // answer with it in hand. Best-effort, single round.
                try {
                  const cont = await fetch(OLLAMA_CHAT, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      model: effectiveModel,
                      messages: [
                        ...ollamaMessages,
                        { role: "assistant", content: assistantBuf },
                        { role: "user", content: continuationPrompt(call.id, r) },
                      ],
                      stream: true,
                      think: false,
                      keep_alive: KEEP_ALIVE_CONVERSATIONAL,
                      options: { think: false, num_predict: maxTokens ?? 250 },
                    }),
                  });
                  if (cont.ok && cont.body) {
                    const cr = cont.body.getReader();
                    while (true) {
                      const { done: cdone, value: cval } = await cr.read();
                      if (cdone) break;
                      if (cval) controllerInner.enqueue(cval);
                    }
                  }
                } catch {
                  /* continuation is best-effort */
                }
              }
              } // close persona-subset `else` (v2.3.11 execution enforcement)
            }
          } catch {
            /* tool processing must never break the chat stream */
          }
        }

        // ---- Model-integrity guard (v2.3.8): flag fabricated tool use ----
        // If the finished answer CLAIMS tool execution but NO tool ran this turn
        // (no result, no audit entry), append an operator-visible warning. The
        // doctrine backstop — ARGOS surfaces fake success even when the model is
        // the proximate cause. The operator caught it once; the system catches
        // it now.
        try {
          // A claim is only a violation when NOTHING real backed it. STRONG
          // tool-execution claims need a real tool; SOFT retrieval claims are
          // also satisfied by vault retrieval / memory recall / research.
          const hadGrounding =
            (retrievalEvent.hits?.length ?? 0) > 0 ||
            memoryEvent.injected === true ||
            researchEventState === "LIVE" ||
            researchEventState === "CACHED";
          const verdict = evaluateIntegrity(assistantBuf, {
            toolRan: toolRanThisTurn,
            hadGrounding,
            explicitToolRequest: toolsEnabled && isExplicitToolRequest(userText, KNOWN_TOOL_IDS),
            // v2.3.11 — a malformed tool attempt + fabricated continuation is
            // caught: either a parser-flagged failure OR a `<tool_id …>` tag
            // (the shape the parser silently skips because it has no "id" key).
            attemptedToolButFailed:
              toolsEnabled &&
              (toolParseFailedThisTurn || hasMalformedToolTag(assistantBuf, KNOWN_TOOL_IDS)),
          });
          if (verdict.violation) {
            const warning = buildIntegrityWarning();
            assistantBuf += warning; // persisted + memory-extracted + visible next turn
            controllerInner.enqueue(
              encoder.encode(`${JSON.stringify({ message: { content: warning } })}\n`)
            );
            controllerInner.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "integrity_warning", reason: INTEGRITY_WARNING_REASON, patterns: verdict.patterns })}\n`
              )
            );
            // Forensic record → state/integrity-violations.jsonl (HUD counter).
            await appendIntegrityViolation({
              type: "fabrication",
              persona: body.personaId ?? null,
              patterns: verdict.patterns,
              missingTool: inferMissingTool(assistantBuf, KNOWN_TOOL_IDS),
              content: assistantBuf,
            });
          }
        } catch {
          /* integrity guard must never break the chat stream */
        }

        // ---- Misrepresentation guard (v2.3.9 doctrine, Layer 2c) ----
        // v2.3.8 catches fabrication (a claim with no tool). This catches the
        // adjacent shape: a tool RAN, returned a clear negative ("MiroFish not
        // running"), and the response frames the completed call as pending
        // ("I await the result") instead of surfacing the outcome. The negative
        // result may be from THIS turn (a continuation) or the most recent prior
        // turn (the forensic case — the operator asks "did you call it" the next
        // turn). Truth is unconditional; a negative result is reported faithfully.
        try {
          const negatives = [...turnToolResults, ...priorNegatives].filter(isNegativeStateResult);
          const misrep = detectMisrepresentation(assistantBuf, negatives);
          if (misrep.violation && misrep.summary) {
            const warning = buildMisrepresentationWarning(misrep.summary);
            assistantBuf += warning; // persisted + visible next turn
            controllerInner.enqueue(
              encoder.encode(`${JSON.stringify({ message: { content: warning } })}\n`)
            );
            controllerInner.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "integrity_warning", reason: "misrepresentation", patterns: [`framed completed call as pending; result was: ${misrep.summary}`] })}\n`
              )
            );
            await appendIntegrityViolation({
              type: "misrepresentation",
              persona: body.personaId ?? null,
              patterns: [`framed completed tool call as pending; actual result: ${misrep.summary}`],
              missingTool: misrep.toolId,
              content: assistantBuf,
            });
          }
        } catch {
          /* misrepresentation guard must never break the chat stream */
        }

        // Tail the stream with our retrieval set so the client can render pills.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(retrievalEvent)}\n`)
        );
        // Phase 10 — research event tail. Emitted after retrieval so
        // the client's NDJSON parser sees them in stable order.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(researchEvent)}\n`)
        );

        // ---- Inference audit (v2.4.2 Phase A) ----
        // Durable, per-turn record of the LITERAL backend + exact model that
        // answered, latency, token counts, and any silent fallback reason. No
        // interpretation. There was no pre-existing chat audit event, so this
        // adds the `chat.inference` kind. Best-effort: never breaks the stream.
        try {
          const auditPrompt = nousResult
            ? nousResult.promptTokens
            : localPromptTokens;
          const auditCompletion = nousResult
            ? nousResult.completionTokens
            : localCompletionTokens;
          const auditTotal = nousResult
            ? nousResult.totalTokens
            : auditPrompt != null && auditCompletion != null
              ? auditPrompt + auditCompletion
              : null;
          await appendAudit("chat.inference", {
            persona: body.personaId,
            backend: answeredBackend,
            model: answeredModel,
            latency_ms: Date.now() - inferenceStart,
            prompt_tokens: auditPrompt,
            completion_tokens: auditCompletion,
            total_tokens: auditTotal,
            fallback_reason: fallbackReason,
          });
        } catch {
          /* audit is best-effort; never break the chat stream */
        }

        controllerInner.close();
        // Phase 11 — release the in-flight slot on natural stream
        // close (scheduler can now tick).
        endInFlight();

        // Phase 9 — fire-and-forget memory extraction. Resolves the
        // operator profile, runs the extractor, persists each
        // candidate. Failures logged + swallowed; chat response is
        // already complete by the time this runs.
        //
        // Operator Auth (2026-05-28): only run extraction for
        // authenticated requests. Guest turns shouldn't poison the
        // operator's memory store with strangers' "I am" / "I prefer"
        // statements — those would surface back to the operator's
        // next prompt and create cross-session contamination.
        const finalAssistant = assistantBuf.trim();
        if (isOperator && finalAssistant.length > 0 && userText.length > 0) {
          void (async () => {
            try {
              const profile = await getOperatorProfile();
              const cands = await extractMemories(
                userText,
                finalAssistant,
                body.personaId as MemoryPersonaScope,
                profile
              );
              for (const c of cands) {
                try {
                  await writeMemory(c);
                } catch (writeErr) {
                  // eslint-disable-next-line no-console
                  console.warn(
                    `[chat] memory write failed (non-fatal): ${
                      (writeErr as Error).message
                    }`
                  );
                }
              }
            } catch (extractErr) {
              // eslint-disable-next-line no-console
              console.warn(
                `[chat] memory extraction failed (non-fatal): ${
                  (extractErr as Error).message
                }`
              );
            }
          })();

          // Memory Phase — semantic cross-session extraction (Bobby). Pure
          // fire-and-forget: returns immediately, never blocks the (already
          // closed) stream, never throws. Stores to operator_facts.jsonl +
          // MEMORY.md so Bartimaeus recalls it in future sessions.
          extractAndStore(userText, finalAssistant, {
            sessionId: null,
            persona: body.personaId,
          });
        }
      } catch (e) {
        clearTimeout(firstTokenTimer);
        if (isAbortError(e)) {
          controllerInner.close();
        } else {
          controllerInner.error(e);
        }
        // Phase 11 — release on error path too.
        endInFlight();
      }
    },
    cancel(reason) {
      clearTimeout(firstTokenTimer);
      reader.cancel(reason).catch(() => undefined);
      controller.abort();
      // Phase 11 — release on client-cancel.
      endInFlight();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      // Vision Phase 1 — header mirror of the vision frame so non-streaming
      // clients / smokes can read the routing decision from headers alone.
      "x-vision-model": effectiveModel,
      "x-vision-used": visionTurn ? "true" : "false",
      // v2.4.2 Phase A — backend mirror so smokes can assert which backend +
      // EXACT model answered (and any silent fallback) from headers alone.
      "x-inference-backend": answeredBackend,
      "x-inference-model": answeredModel,
      "x-inference-fallback": fallbackReason ?? "none",
    },
  });
}
