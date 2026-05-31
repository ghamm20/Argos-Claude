import { NextRequest } from "next/server";
import { isPersonaSelectable, type PersonaId } from "@/lib/personas";
import { resolvePersona } from "@/lib/persona-server";
import { retrieve } from "@/lib/vault/store";
import type { Confidence, RetrievalHit } from "@/lib/vault/types";
import { AVAILABLE_MODELS, isAvailableModel } from "@/lib/store";
import { getAvailableModelsAdditions } from "@/lib/persona-overrides";
import { getOllamaBase } from "@/lib/ollama-config";
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
// Phase 10 (2026-05-28) — research orchestrator. needsResearch is
// imported alongside so we can short-circuit without touching the
// network on non-research turns.
import { runResearch } from "@/lib/research";
import type { ResearchReport } from "@/lib/research/types";
// Phase 11 — in-flight chat tracking + scheduler boot + post-hook.
import { begin as beginInFlight, end as endInFlight } from "@/lib/chat/inflight";
import { ensureSchedulerStarted } from "@/lib/research/scheduler";
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
}

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

function lastUserText(msgs: WireMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].content;
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
  const authSettings = await readSettings().catch(() => null);
  const requirePin = authSettings?.requirePin === true;
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

  // ---- Phase 10 research (graceful: never breaks chat) ----
  // Only fires for operator turns. Guest turns get no research
  // context — keeps the network-mode boundary clean (guest = local
  // only). Failures degrade to "no research block" silently.
  let researchReport: ResearchReport | null = null;
  if (isOperator && userText) {
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
  const systemParts: string[] = [baseSystemPrompt];
  if (memoryBlock.length > 0) {
    systemParts.push(memoryBlock);
  }
  if (researchReport) {
    systemParts.push(buildResearchBlock(researchReport));
  }
  if (retrievedHits.length > 0) {
    systemParts.push(buildRetrievalBlock(retrievedHits));
  }
  if (body.truthMode === true) {
    systemParts.push(TRUTH_MODE_CLAUSE);
  }
  const systemPrompt = systemParts.join("\n\n");

  const ollamaMessages: WireMessage[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // ---- Open Ollama stream ----
  const controller = new AbortController();
  const firstTokenTimer = setTimeout(() => {
    controller.abort();
  }, FIRST_TOKEN_TIMEOUT_MS);

  let upstream: Response;
  try {
    // v1.1 Task 2: per-persona `think` flag (was hardcoded `false`).
    // Default is `false` if persona doesn't declare — preserves the
    // Phase 2-RB doctrine for safety on gemma4/qwen3-thinking models
    // (they emit ALL output via message.thinking + zero into
    // message.content when think:true). Each persona sets this
    // explicitly in lib/personas.ts; see MODELS.md for which models
    // require which.
    const personaThink = persona.think === true;
    upstream = await fetch(OLLAMA_CHAT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: body.model,
        messages: ollamaMessages,
        stream: true,
        think: personaThink,
        options: { think: personaThink },
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
      return abort(404, `model not found: ${body.model}`, {
        hint: `Run: ollama pull ${body.model}`,
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

  const reader = upstream.body.getReader();
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
          };
          if (parsed?.message?.content) {
            assistantBuf += parsed.message.content;
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
        // Tail the stream with our retrieval set so the client can render pills.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(retrievalEvent)}\n`)
        );
        // Phase 10 — research event tail. Emitted after retrieval so
        // the client's NDJSON parser sees them in stable order.
        controllerInner.enqueue(
          encoder.encode(`${JSON.stringify(researchEvent)}\n`)
        );
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
    },
  });
}
