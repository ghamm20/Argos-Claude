#!/usr/bin/env node
// splice-phase2.mjs — one-shot Phase 2 extraction tool (2026-06-10).
// Moves the POST body of app/api/chat/route.ts VERBATIM (byte-for-byte)
// into lib/chat/orchestrator.ts as handleChat(), and rewrites route.ts as a
// thin shim. Programmatic splice = zero transcription risk on ~1460 lines.

import fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routePath = join(repoRoot, "app", "api", "chat", "route.ts");
const src = fs.readFileSync(routePath, "utf8");

const MARKER = "export async function POST(req: NextRequest) {";
const idx = src.indexOf(MARKER);
if (idx < 0) throw new Error("POST marker not found");
const body = src.slice(idx + MARKER.length); // verbatim through final }

const header = `// lib/chat/orchestrator.ts
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
const OLLAMA_CHAT = \`\${OLLAMA_BASE}/api/chat\`;
// Tool ids for inferMissingTool (which tool the model falsely claimed).
const KNOWN_TOOL_IDS = toolSummaries().map((t) => t.id);

export async function handleChat(req: NextRequest): Promise<Response> {`;

fs.writeFileSync(join(repoRoot, "lib", "chat", "orchestrator.ts"), header + body, "utf8");

const newRoute = `// app/api/chat/route.ts
//
// Phase 2 (2026-06-10) — thin shim. The chat orchestrator (the former
// 1,400-line POST handler) lives in lib/chat/orchestrator.ts; wire types in
// lib/chat/wire.ts; prompt blocks in lib/chat/blocks.ts; module boot kickers
// in lib/chat/boot.ts (imported here for side effects, preserving the
// original "boot on first route load" timing). Pure refactor — zero behavior
// change, proven byte-identical by scripts/regress-phase2.mjs.

import "@/lib/chat/boot";
import { handleChat } from "@/lib/chat/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Parameters<typeof handleChat>[0]) {
  return handleChat(req);
}
`;
fs.writeFileSync(routePath, newRoute, "utf8");
console.log("spliced: lib/chat/orchestrator.ts written; route.ts is now a thin shim");
