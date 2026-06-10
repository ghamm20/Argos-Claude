// lib/chat/orchestrator.ts
//
// Phase 2 (2026-06-10) — THE CHAT ORCHESTRATOR, extracted from
// app/api/chat/route.ts (which is now a thin shim). handleChat() below is the
// former POST handler moved VERBATIM — validation, model/backend resolution,
// retrieval/memory/research context, system-prompt assembly, forced grounding,
// Nous/Ollama dispatch, the stream pump with the tool loop, both integrity
// guards, the inference audit, and fire-and-forget memory extraction.
//
// Pure refactor: zero behavior change (proven byte-identical pre/post by
// scripts/regress-phase2.mjs). Wire types/bounds/helpers live in ./wire,
// prompt-block builders in ./blocks, module boot kickers in ./boot.

import { NextRequest } from "next/server";
import { isPersonaSelectable } from "@/lib/personas";
import { resolvePersona } from "@/lib/persona-server";
import { retrieve } from "@/lib/vault/store";
import type { RetrievalHit } from "@/lib/vault/types";
import { AVAILABLE_MODELS, isAvailableModel } from "@/lib/store";
import { getAvailableModelsAdditions } from "@/lib/persona-overrides";
import { getOllamaBase, KEEP_ALIVE_CONVERSATIONAL } from "@/lib/ollama-config";
import { resolveNumCtx } from "@/lib/model-ctx";
// Vision Phase 1 (2026-06-02) — image turns route to the multimodal model
// (gemma4-turbo) regardless of persona; text turns stay on the persona model.
import {
  messagesHaveImages,
  resolveChatModel,
  stripDataUrl,
} from "@/lib/vision";
// Memory Phase (2026-06-02) — semantic cross-session memory.
import { retrieveMemories } from "@/lib/memory-retrieve";
import { extractAndStore } from "@/lib/memory-extract";
// Tools Phase (2026-06-02) — Bartimaeus tool suite.
import {
  buildToolAwarenessBlock,
  parseToolCalls,
  continuationPrompt,
} from "@/lib/tools/chat-tools";
import { callOriginatesFromEmail } from "@/lib/email/guards";
import { getGpuProfile } from "@/lib/gpu/detect";
import { resolveModelForRole, listInstalledModels, type ModelRole } from "@/lib/models/registry";
import { shouldUseLeanToolFrame } from "@/lib/models/concurrency";
import { requestTool } from "@/lib/tools/executor";
import { appendParseFailureAudit } from "@/lib/tools/audit";
import { toolSummaries } from "@/lib/tools/registry";
// v2.3.11 — per-persona tool distribution (scoped awareness + execution enforcement).
import { toolsForPersona, personaHasTool } from "@/lib/persona-tool-subsets";
// Model-integrity guard (v2.3.8) + misrepresentation guard (v2.3.9).
import {
  evaluateIntegrity,
  buildIntegrityWarning,
  INTEGRITY_WARNING_REASON,
  inferMissingTool,
  isExplicitToolRequest,
  hasMalformedToolTag,
  PARSE_FAILURE_SYSTEM_NOTE,
  FABRICATION_SYSTEM_NOTE,
  type ToolResultLike,
  isNegativeStateResult,
  detectMisrepresentation,
  buildMisrepresentationWarning,
  buildRecentToolResultsBlock,
  buildMisrepCorrectionNote,
} from "@/lib/tool-integrity";
import { appendIntegrityViolation } from "@/lib/integrity-log";
// Forced current-facts grounding (2026-06-02).
import { detectCurrentFacts, buildCurrentFactsBlock, buildChainBlock, buildNoGroundingBlock } from "@/lib/current-facts-detector";
import { buildWeatherBlock } from "@/lib/tools/open-meteo";
// Phase 9 (router) — keyword-only persona routing suggestion.
import { classifyByKeyword, ROUTE_CONFIDENCE_THRESHOLD } from "@/lib/persona-router";
// Phase 9 — persistent memory.
import { retrieveMemoriesForPrompt } from "@/lib/memory/retriever";
import { extractMemories } from "@/lib/memory/extractor";
import { writeMemory, getOperatorProfile } from "@/lib/memory/store";
import type { MemoryPersonaScope } from "@/lib/memory/schema";
// Operator Auth (2026-05-28) — auth-mode gate.
import { readSettings } from "@/lib/settings";
import { parseBearer, isTokenValid } from "@/lib/auth";
// v2.4.2 Phase A — inference backend switch.
import {
  resolveBackend,
  resolveLocalModel,
  resolveCloudDataPolicy,
  callNous,
  type NousResult,
} from "@/lib/inference-backend";
import { decryptSecret } from "@/lib/web/secrets";
import { appendAudit } from "@/lib/audit";
// Phase 10 (2026-05-28) — research orchestrator.
import { runResearch } from "@/lib/research";
import type { ResearchReport } from "@/lib/research/types";
// Phase 11 — in-flight chat tracking.
import { begin as beginInFlight, end as endInFlight } from "@/lib/chat/inflight";
import { afterReport } from "@/lib/research/afterReport";
// Phase 2 extraction — wire types/bounds/helpers + prompt-block builders.
import {
  FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_TOP_K,
  MAX_MESSAGES,
  MAX_CONTENT_LENGTH,
  VALID_ROLES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_CHARS,
  type WireRole,
  type WireMessage,
  type ChatRequestBody,
  jsonError,
  isAbortError,
  isConnRefused,
  makeSyntheticReader,
  lastUserText,
  priorUserText,
} from "@/lib/chat/wire";
import {
  TRUTH_MODE_CLAUSE,
  type CitedHit,
  isCanonQuery,
  buildResearchBlock,
  buildRetrievalBlock,
} from "@/lib/chat/blocks";

const OLLAMA_BASE = getOllamaBase();
const OLLAMA_CHAT = `${OLLAMA_BASE}/api/chat`;
// Tool ids for inferMissingTool (which tool the model falsely claimed).
const KNOWN_TOOL_IDS = toolSummaries().map((t) => t.id);

export async function handleChat(req: NextRequest): Promise<Response> {
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
  // ---- G2: tiered model resolution ----
  // The persona's conversational model is now a FUNCTION of the detected GPU
  // tier. On the lean 3060 Ti this returns the operator's requested body.model
  // byte-for-byte (leanOverride); on ample hardware it upgrades from the
  // registry, falling back to body.model if the upgrade isn't pulled. Identity/
  // voice is unchanged across tiers — only the underlying model scales.
  const gpuProfile = await getGpuProfile().catch(() => null);
  const installedModels = await listInstalledModels().catch(() => new Set<string>());
  const tierOverride = (role: string) =>
    settings?.perRoleTierOverride?.[role];
  let tieredPersonaModel = body.model;
  if (gpuProfile) {
    const r = await resolveModelForRole(`persona:${body.personaId}` as ModelRole, gpuProfile, {
      leanOverride: body.model,
      installed: installedModels,
      tierOverride: tierOverride(`persona:${body.personaId}`),
    });
    tieredPersonaModel = r.model;
  }
  const reboundLocalModel = resolveLocalModel(
    body.personaId,
    tieredPersonaModel,
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
  // `sensitive` → stripped on a REDACTED Nous turn. `alwaysStrip` → stripped on
  // ANY Nous turn regardless of cloudDataPolicy (Guard 4: email content never
  // leaves the box, even under "full").
  const partMeta: Array<{ label: string; sensitive: boolean; alwaysStrip: boolean }> = [];
  const addPart = (text: string, label: string, sensitive = false, alwaysStrip = false): void => {
    systemParts.push(text);
    partMeta.push({ label, sensitive, alwaysStrip });
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
  // G2: the tool-execution model is tier-resolved too. Lean → exactly
  // settings.toolExecutionModel (hermes3:8b); ample → the registry upgrade
  // (qwen3-64k), falling back to the lean value until it's pulled.
  let toolExecutionModel = settings?.toolExecutionModel ?? "";
  if (gpuProfile && toolExecutionModel.length > 0) {
    const r = await resolveModelForRole("tool-execution", gpuProfile, {
      leanOverride: toolExecutionModel,
      installed: installedModels,
      tierOverride: tierOverride("tool-execution"),
    });
    toolExecutionModel = r.model;
  }
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
  // ---- Email injection guards (Stage 3) ----
  // Split email tool results from the rest. Email content is UNTRUSTED: it gets
  // its own always-cloud-stripped segment (Guard 4) and arms email_context_gate
  // (Guard 3 — any tool op this turn is forced through approval) + the
  // origin-check (Guard 2 — a tool call whose raw text came from email content
  // is never executed).
  const emailPriorResults = priorToolResults.filter((r) => r.toolId === "email_read");
  const otherPriorResults = priorToolResults.filter((r) => r.toolId !== "email_read");
  const emailContexts: string[] = emailPriorResults
    .map((r) => {
      const ec = (r.data as { emailContext?: unknown } | null)?.emailContext;
      return typeof ec === "string" ? ec : "";
    })
    .filter(Boolean);
  const emailContextActive = emailContexts.length > 0;
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
    if (otherPriorResults.length > 0) {
      addPart(buildRecentToolResultsBlock(otherPriorResults), "tool_results:prior", true);
    }
    // Guard 4 — email content is its own always-cloud-stripped segment. It
    // already carries the untrusted envelope + neutralized tool syntax (applied
    // at read time). sensitive AND alwaysStrip → gone on every Nous turn.
    if (emailContexts.length > 0) {
      addPart(emailContexts.join("\n\n"), "email:content", true, true);
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

  // ---- Stage 12: tier-conditional LEAN TOOL FRAME ----
  // The Stage-1 finding: a heavy persona prompt (Bart's full "*" set + identity +
  // doctrine) drowned hermes3's tool emission on lean. On lean/mid tier
  // (shouldUseLeanToolFrame), an EXPLICIT tool turn gets a LEAN system prompt — brief
  // identity for voice + a one-line integrity reminder + the tool-awareness block
  // — instead of the full persona prompt. On ample the full prompt is tolerated
  // (the stub returns false), so the richer frame applies there. DETECTED
  // decision, same code. Non-tool turns and the lean CHAT path are untouched.
  let toolModelFrame: string | null = null;
  if (toolModelTurn && gpuProfile && shouldUseLeanToolFrame(gpuProfile.tier)) {
    toolModelFrame = [
      `You are ${persona.name}.`,
      "INTEGRITY: never claim a tool ran or report a result you did not actually receive.",
      buildToolAwarenessBlock(persona.id === "bartimaeus" ? undefined : personaToolIds),
    ].join("\n\n");
  }

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
    // Stage 12: an explicit tool turn on lean/mid uses the lean frame; every
    // other turn (including the lean CHAT path) uses the full systemPrompt.
    { role: "system", content: toolModelFrame ?? systemPrompt },
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
      // A segment is stripped if: it's alwaysStrip (Guard 4 — email content,
      // regardless of policy), OR the policy is "redacted" and it's sensitive.
      const stripSegment = (m: { sensitive: boolean; alwaysStrip: boolean }) =>
        m.alwaysStrip || (cloudPolicy === "redacted" && m.sensitive);
      {
        const kept: string[] = [];
        const strippedLabels: string[] = [];
        let bytesWithheld = 0;
        for (let i = 0; i < systemParts.length; i++) {
          if (stripSegment(partMeta[i])) {
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
            labels_kept: partMeta.filter((m) => !stripSegment(m)).map((m) => m.label),
            bytes_withheld: bytesWithheld,
            vault_chunks_stripped: retrievedHits.length,
            memory_facts_injected: recall.factsFound,
            prior_tool_results_stripped: otherPriorResults.length,
            email_content_stripped: emailContexts.length,
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
      // Phase 1.5 (2026-06-10): floor the context window for models whose
      // modelfile sets no num_ctx — the ~4.1k-token operator prompt saturates
      // Ollama's 4096 default and generation dies after 1 token. Models that
      // declare their own num_ctx (gemma-4: 131072) are untouched.
      const numCtx = await resolveNumCtx(effectiveModel);
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
            ...(numCtx != null ? { num_ctx: numCtx } : {}),
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
              } else if (callOriginatesFromEmail(call.raw, emailContexts)) {
                // Guard 2 (Stage 3, HARD origin check) — a tool call whose raw
                // text came from email content is an injection. It is NEVER
                // executed; it's audited and surfaced as an injection attempt.
                await appendAudit("email.injection_attempt", {
                  toolId: call.id,
                  persona: body.personaId,
                  reason: "tool call originated from untrusted email content — blocked, not executed",
                  raw: call.raw.slice(0, 400),
                }).catch(() => {});
                controllerInner.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      type: "email_injection_blocked",
                      toolId: call.id,
                      reason: "tool call originated from email content; blocked",
                    })}\n`
                  )
                );
              } else {
                toolRanThisTurn = true; // a permitted model-initiated tool call was routed
                // Guard 3 (Stage 3) — when email content is in context, force
                // approval on ANY tool op (even normally-safe/ungated ones).
                const outcome = await requestTool(call.id, call.params, {
                  sessionId: null,
                  personaId: body.personaId,
                  model: effectiveModel,
                }, { forceApproval: emailContextActive });
                if (emailContextActive && outcome.kind === "approval") {
                  await appendAudit("email_context_gate", {
                    toolId: call.id,
                    persona: body.personaId,
                    reason: "email content in context — tool op forced through operator approval",
                  }).catch(() => {});
                }
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
                      plan: outcome.plan ?? null,
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
                  // Same num_ctx floor as the main call — the continuation
                  // carries the full prompt PLUS the tool result.
                  const contNumCtx = await resolveNumCtx(effectiveModel);
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
                      options: {
                        think: false,
                        num_predict: maxTokens ?? 250,
                        ...(contNumCtx != null ? { num_ctx: contNumCtx } : {}),
                      },
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
