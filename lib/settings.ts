import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import type { PersonaId } from "./personas";
import { appendAudit } from "./audit";

export const SETTINGS_VERSION = 1;

/** Phase 11 — research scheduler config. All intervals in minutes;
 *  set to 0 to disable that stream's scheduled runs. */
export interface ResearchScheduleConfig {
  enabled: boolean;
  weatherMinutes: number;
  newsMinutes: number;
  aiUpdatesMinutes: number;
  arxivMinutes: number;
}

/** Phase 10 Heartbeat (2026-05-31) — ambient autonomous tick config.
 *  enabled:false keeps the background heartbeat off (opt-in, like the
 *  research scheduler). intervalMinutes is the wake cadence (default 30). */
export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
}

/** Web Capability TIER 0 (2026-06-02) — external API secrets. Values are
 *  stored ENCRYPTED at rest (AES-256-GCM via lib/web/secrets.ts); the GET
 *  /api/settings response masks them. null = unset. */
export interface ApiKeys {
  /** GitHub Personal Access Token (lifts /search rate 60→5000/hr). */
  github: string | null;
  // Tier 4 (v2.4.0) operator-specific keyed sources. All optional — the tool
  // gracefully reports "not configured" when null (never fabricates).
  /** Have I Been Pwned API key (haveibeenpwned.com, paid). */
  hibp: string | null;
  /** api.congress.gov key (free, api.data.gov). */
  congress_gov: string | null;
  /** api.sam.gov key (free, api.data.gov). */
  sam_gov: string | null;
  /** USDA NASS QuickStats key (free, quickstats.nass.usda.gov). */
  usda_nass: string | null;
  /** NOAA NCEI CDO token (free, ncdc.noaa.gov/cdo-web). */
  noaa_cdo: string | null;
  /** FRED API key (free, St. Louis Fed). */
  fred: string | null;
}

/**
 * Phase 7-C (v2.4.1) — ElevenLabs TTS for Bartimaeus (Cassius voice), with Piper
 * as the offline fallback. Network-OPTIONAL: empty apiKey → Bart stays on Piper.
 * `apiKey` is encrypted at rest (same AES-256-GCM as apiKeys) + masked in the
 * GET /api/settings response; never logged.
 */
export interface ElevenLabsConfig {
  /** ElevenLabs API key (ciphertext at rest). null/"" → ElevenLabs disabled. */
  apiKey: string | null;
  /** Bart's voice id. Default = Cassius (aGv5jHWKBy8K5xKvYeSX). */
  bartVoiceId: string;
  /** Model id. Default = eleven_multilingual_v2. */
  model: string;
}

/**
 * v2.4.2 Phase A — inference backend switch. Two INDEPENDENT axes:
 *  - inferenceBackend / perPersonaBackend: route a persona's chat call to the
 *    local Ollama daemon or the Nous Research API
 *    (nvidia/nemotron-3-ultra:free, free tier).
 *  - useReboundModels: a SEPARATE feature flag that swaps Juniper + Bobby to
 *    the local gemma-4 model. Default off → nothing moves.
 * nousApiKey is encrypted at rest (AES-256-GCM via lib/web/secrets.ts) and
 * masked in GET /api/settings, exactly like the ElevenLabs key. Never logged.
 */
export interface GmailConfig {
  /** OAuth client id (non-secret identifier). */
  clientId: string | null;
  /** OAuth client secret — ciphertext at rest. */
  clientSecret: string | null;
  /** OAuth refresh token — ciphertext at rest. Minted once via gmail-auth. */
  refreshToken: string | null;
}

// Stage 10 (2026-06-09) — fleet (remote tailnet executor) endpoints. Each is a
// remote Ollama on the tailnet. `policy` governs what local context may leave
// the ARGOS box to that endpoint — "redacted" (default) keeps vault/memory home
// (tailnet is trusted-ER, not trusted); "full" sends everything. Email content
// NEVER leaves regardless. Default: no endpoints configured.
export interface FleetEndpoint {
  id: string;
  /** Remote Ollama base URL, e.g. http://100.x.y.z:11434 (tailnet). */
  baseUrl: string;
  policy: "redacted" | "full";
}
export interface FleetConfig {
  endpoints: FleetEndpoint[];
}

export type InferenceBackendChoice = "local" | "nous";
export type PersonaBackendChoice = "local" | "nous" | "default";
// Gate 2 (2026-06-09) — per-persona cloud data policy. Governs what local
// context (vault chunks, memory facts, prior tool results) may leave the box on
// a Nous-backend turn. "redacted" (DEFAULT for every persona) strips those
// segments before the cloud call; "full" sends everything and REQUIRES explicit
// per-persona opt-in via Settings → Inference. Absent → "redacted".
export type CloudDataPolicy = "full" | "redacted";
export interface PerPersonaCloudPolicy {
  bartimaeus?: CloudDataPolicy;
  juniper?: CloudDataPolicy;
  sage?: CloudDataPolicy;
  bobby?: CloudDataPolicy;
}
export interface PerPersonaBackend {
  bartimaeus?: PersonaBackendChoice;
  juniper?: PersonaBackendChoice;
  sage?: PersonaBackendChoice;
  bobby?: PersonaBackendChoice;
}

export interface PersistedSettings {
  version: number;
  defaultPersona: PersonaId;
  defaultModel: string;
  updatedAt: number;
  // Operator Auth (2026-05-28). Both fields are additive — older
  // settings.json files load with the defaults below via readSettings'
  // null-coalescing merge, so existing deployments boot unchanged.
  /** SHA-256 hex of `"ARGOS_OPERATOR_" + pin.length + pin`, written
   *  by the client on PIN set. `null` means no PIN has been
   *  configured — combined with requirePin:false (the default), the
   *  app always boots into operator mode. */
  operatorPinHash: string | null;
  /** When true, /api/chat treats unauthenticated requests as guest
   *  (uses guestSystemPrompt, suppresses memory). When false, every
   *  request is treated as operator regardless of Authorization
   *  header. Default false preserves pre-auth behavior; operator
   *  opt-in via Settings UI. */
  requirePin: boolean;
  // Phase 11 — Pushover credentials. Both null means alerts are
  // disabled (alerts.ts skips silently). Operator sets via Settings
  // UI; never embedded in build.
  operatorPushoverUserKey: string | null;
  operatorPushoverApiToken: string | null;
  // Task 5 (2026-05-31) — Twilio SMS fallback. When Pushover is unset
  // or its send fails AND all four of these are present, alerts fall
  // back to an SMS via Twilio. All optional (null = no fallback).
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioFrom: string | null;
  twilioTo: string | null;
  /** Phase 11 — scheduler config. enabled:false keeps the background
   *  timers off; enabled:true starts them on next chat-route boot. */
  researchSchedule: ResearchScheduleConfig;
  /** Phase 11 — keyword watchlist that, when matched in a research
   *  summary or finding, forces an alert even below the confidence
   *  threshold. Case-insensitive substring match. */
  researchWatchlist: string[];
  /** Phase 11 — minimum confidence to fire a Pushover alert when
   *  no watchlist match is present. 0.8 default per directive. */
  researchAlertConfidenceThreshold: number;
  /** Phase 11 — arXiv topic queries (default 4). Each fires its own
   *  query against export.arxiv.org. */
  researchArxivTopics: string[];
  /** Phase 10 Heartbeat (2026-05-31) — ambient autonomous tick. */
  heartbeat: HeartbeatConfig;
  /** Web Capability TIER 0 (2026-06-02) — encrypted external API secrets. */
  apiKeys: ApiKeys;
  /** Phase 7-C (v2.4.1) — ElevenLabs TTS for Bartimaeus (Piper fallback). */
  elevenlabs: ElevenLabsConfig;
  /** v2.4.2 Phase A — global inference backend (default "local"). */
  inferenceBackend: InferenceBackendChoice;
  /** v2.4.2 Phase A — optional per-persona backend override; "default" (or
   *  absent) respects the global inferenceBackend. */
  perPersonaBackend: PerPersonaBackend;
  /** Gate 2 (2026-06-09) — per-persona cloud data policy. Absent persona →
   *  "redacted" (the safe default): vault/memory/tool-result segments are
   *  stripped before any Nous call. "full" is explicit opt-in per persona. */
  cloudDataPolicy: PerPersonaCloudPolicy;
  /** v2.4.2 Phase A — Nous API key (ciphertext at rest). null → Nous disabled;
   *  any "nous" route falls back to local. */
  nousApiKey: string | null;
  /** v2.4.2 Phase A — feature flag (SEPARATE from the backend switch): rebind
   *  Juniper + Bobby to the local gemma-4 model. Default false → unchanged. */
  useReboundModels: boolean;
  /** Stage 10 (2026-06-09) — fleet remote-executor endpoints (tailnet Ollama).
   *  Default: none configured. */
  fleet: FleetConfig;
  /** G2 (2026-06-09) — optional per-role GPU tier override. Lets the operator
   *  PIN a role below the detected tier (testing / VRAM-sharing). Keys are model
   *  roles ("tool-execution", "judge", "research", "persona:<id>"); values are a
   *  tier. Absent → the role follows the detected tier. The resolver never lets
   *  an override raise a role ABOVE the detected hardware. */
  perRoleTierOverride: Record<string, "lean" | "mid" | "ample">;
  /** Stage 3 (2026-06-09) — Gmail read-only OAuth credentials. clientSecret +
   *  refreshToken are ciphertext at rest; clientId is a non-secret identifier.
   *  All null until the operator mints a refresh token (scripts/gmail-auth.mjs).
   *  Scope is gmail.readonly — the token cannot send/delete/modify. */
  gmail: GmailConfig;
  /** Tool-call enablement (2026-06-09) — the dedicated tool-emission model.
   *  When the operator EXPLICITLY commands a tool (isExplicitToolRequest),
   *  /api/chat routes that turn to this model — same seam as vision routing:
   *  only the MODEL changes, the persona voice stays. Default hermes3:8b
   *  (3/3 clean in the round-2 emission harness vs 1/3 for the best persona
   *  model — scripts/harness-evidence.jsonl). Self-heals off retired models
   *  like defaultModel does. */
  toolExecutionModel: string;
}

// Phase 2 (2026-05-25): Bartimaeus is the boot default. Model is the
// Qwen3.5 9B uncensored that Bart + Juniper share. Operator-overridable
// via the Settings UI; writes to ARGOS_ROOT/config/settings.json
// (atomic temp+rename).
//
// Operator Auth (2026-05-28) added operatorPinHash + requirePin. Both
// default to "auth disabled" so older deployments + first-launch behave
// identically to the pre-auth build.
const DEFAULT_SETTINGS: PersistedSettings = {
  version: SETTINGS_VERSION,
  defaultPersona: "bartimaeus",
  // Bart model swap (2026-06-02): Bart now binds to
  // aratan/gemma-4-E4B-q8-it-heretic:latest (memory works; see
  // PILOT_FIXES_VALIDATION.md). The boot model loads this so the first chat
  // doesn't pay a cold-swap. (Existing deployments keep their settings.json
  // defaultModel; the persona binding is what drives Bart's model.)
  defaultModel: "aratan/gemma-4-E4B-q8-it-heretic:latest",
  updatedAt: 0,
  operatorPinHash: null,
  requirePin: false,
  // Phase 11 defaults: alerts disabled until operator supplies keys;
  // scheduler disabled until operator opts in. Watchlist + thresholds
  // pre-populated with sane values per the directive.
  operatorPushoverUserKey: null,
  operatorPushoverApiToken: null,
  // Task 5: Twilio SMS fallback disabled until operator supplies creds.
  twilioAccountSid: null,
  twilioAuthToken: null,
  twilioFrom: null,
  twilioTo: null,
  researchSchedule: {
    enabled: false,
    weatherMinutes: 30,
    newsMinutes: 60,
    aiUpdatesMinutes: 120,
    arxivMinutes: 360, // 6h — matches arXiv cache TTL
  },
  researchWatchlist: [],
  researchAlertConfidenceThreshold: 0.8,
  researchArxivTopics: [
    "local LLM",
    "multi-agent systems",
    "RAG",
    "AI security",
  ],
  // Phase 10 Heartbeat: disabled until the operator opts in; 30-minute
  // default cadence per directive.
  heartbeat: {
    enabled: false,
    intervalMinutes: 30,
  },
  // Web Capability TIER 0: no API keys until the operator supplies them.
  apiKeys: {
    github: null,
    hibp: null,
    congress_gov: null,
    sam_gov: null,
    usda_nass: null,
    noaa_cdo: null,
    fred: null,
  },
  // Phase 7-C: ElevenLabs disabled until the operator supplies a key; voice +
  // model pre-filled with Cassius / eleven_multilingual_v2 per directive.
  elevenlabs: {
    apiKey: null,
    bartVoiceId: "aGv5jHWKBy8K5xKvYeSX",
    model: "eleven_multilingual_v2",
  },
  // v2.4.2 Phase A — inference backend switch. Defaults keep everything LOCAL
  // and nothing rebound, so the default deployment is byte-for-byte unchanged
  // until the operator opts in.
  inferenceBackend: "local",
  perPersonaBackend: {},
  // Gate 2: every persona defaults to "redacted" by being absent here — the
  // resolver treats absent as redacted. The default deployment never sends
  // vault/memory/tool-results to the cloud unless the operator opts a persona
  // into "full".
  cloudDataPolicy: {},
  nousApiKey: null,
  // Stage 4 (2026-06-09): flipped ON by operator ruling. Rebinds Juniper +
  // Bobby from their own bindings to the proven gemma-4-heretic (already
  // resident for Bart/Sage) — gemma-4 emits the tool format far more reliably
  // than notmythos (Bobby's prior binding), improving IMPLICIT tool use, and
  // collapses model swaps on the lean 8GB tier (all four personas share one
  // resident model). Explicit tool turns route to hermes3 regardless (Stage 1).
  useReboundModels: true,
  // Tool-call enablement (2026-06-09): hermes3:8b won the emission harness
  // (round 2, prompt B: 3/3 clean, ~0.7s warm, 4.7 GB — fits VRAM whole).
  toolExecutionModel: "hermes3:8b",
  // Stage 10: no fleet endpoints by default (the Ubuntu rig is configured by
  // the operator when it's on the tailnet).
  fleet: { endpoints: [] },
  // G2: no per-role tier overrides by default → every role follows the
  // detected GPU tier (lean on the 3060 Ti).
  perRoleTierOverride: {},
  // Stage 3: Gmail read-only — unconfigured until the operator mints a token.
  gmail: { clientId: null, clientSecret: null, refreshToken: null },
};

export function configDir(): string {
  return path.join(argosRoot(), "config");
}

export function settingsPath(): string {
  return path.join(configDir(), "settings.json");
}

// Retired default-model pointers (2026-06-03). When a persona's bound model is
// swapped (Bart: royhodge812/Orchestrator → aratan/gemma-4-E4B-q8-it-heretic in
// v2.3.2), the CODE default is updated but an EXISTING settings.json keeps the
// old value and silently overrides it (parsed.defaultModel ?? default). Every
// defaultModel consumer — smoke-retrieval, background tasks resolving the boot
// model — then calls the dead model, which surfaced as the "1-token answer"
// retrieval flake (mis-attributed to libuv/task #161). Self-heal: a persisted
// defaultModel in this set normalizes to the current default. Orchestrator is
// still allow-listed (AVAILABLE_MODELS) for /api/chat + persona-overrides
// rollback — this only retires it from the DEFAULT slot, which it was swapped
// out of precisely because of its hardwired identity.
const RETIRED_DEFAULT_MODELS = new Set<string>([
  "royhodge812/Orchestrator:lates",
  "royhodge812/Orchestrator:latest",
]);

function normalizeDefaultModel(persisted: string | undefined): string {
  const m = persisted ?? DEFAULT_SETTINGS.defaultModel;
  return RETIRED_DEFAULT_MODELS.has(m) ? DEFAULT_SETTINGS.defaultModel : m;
}

// Tool-call enablement (2026-06-09): same self-heal pattern for the tool
// model — a persisted pointer at a retired (or blank) model normalizes to the
// current default rather than silently calling a dead model.
function normalizeToolExecutionModel(persisted: unknown): string {
  const m =
    typeof persisted === "string" && persisted.trim().length > 0
      ? persisted.trim()
      : DEFAULT_SETTINGS.toolExecutionModel;
  return RETIRED_DEFAULT_MODELS.has(m)
    ? DEFAULT_SETTINGS.toolExecutionModel
    : m;
}

// Gate 2 (2026-06-09): load-time sanitizer for the per-persona cloud policy.
// Only an EXPLICIT "full" survives; every other value (including "redacted",
// which is already the resolver default) is dropped, keeping the stored object
// minimal and fail-safe. Unknown persona keys are discarded.
const CLOUD_POLICY_PERSONAS = ["bartimaeus", "juniper", "sage", "bobby"] as const;
function sanitizeCloudPolicy(raw: unknown): PerPersonaCloudPolicy {
  if (!raw || typeof raw !== "object") return {};
  const out: PerPersonaCloudPolicy = {};
  for (const p of CLOUD_POLICY_PERSONAS) {
    if ((raw as Record<string, unknown>)[p] === "full") out[p] = "full";
  }
  return out;
}

export async function readSettings(): Promise<PersistedSettings> {
  try {
    const raw = await fsp.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      version: SETTINGS_VERSION,
      defaultPersona: parsed.defaultPersona ?? DEFAULT_SETTINGS.defaultPersona,
      defaultModel: normalizeDefaultModel(parsed.defaultModel),
      updatedAt: parsed.updatedAt ?? DEFAULT_SETTINGS.updatedAt,
      // Forward-compat: missing → default. Older settings.json files
      // pre-dating the Operator Auth field still load cleanly.
      operatorPinHash:
        parsed.operatorPinHash === undefined
          ? DEFAULT_SETTINGS.operatorPinHash
          : parsed.operatorPinHash,
      requirePin:
        parsed.requirePin === undefined
          ? DEFAULT_SETTINGS.requirePin
          : parsed.requirePin,
      // Phase 11 forward-compat: missing → default. Older
      // settings.json files (Phase 10 and earlier) load cleanly.
      operatorPushoverUserKey:
        parsed.operatorPushoverUserKey === undefined
          ? DEFAULT_SETTINGS.operatorPushoverUserKey
          : parsed.operatorPushoverUserKey,
      operatorPushoverApiToken:
        parsed.operatorPushoverApiToken === undefined
          ? DEFAULT_SETTINGS.operatorPushoverApiToken
          : parsed.operatorPushoverApiToken,
      twilioAccountSid:
        parsed.twilioAccountSid === undefined
          ? DEFAULT_SETTINGS.twilioAccountSid
          : parsed.twilioAccountSid,
      twilioAuthToken:
        parsed.twilioAuthToken === undefined
          ? DEFAULT_SETTINGS.twilioAuthToken
          : parsed.twilioAuthToken,
      twilioFrom:
        parsed.twilioFrom === undefined
          ? DEFAULT_SETTINGS.twilioFrom
          : parsed.twilioFrom,
      twilioTo:
        parsed.twilioTo === undefined
          ? DEFAULT_SETTINGS.twilioTo
          : parsed.twilioTo,
      researchSchedule: {
        ...DEFAULT_SETTINGS.researchSchedule,
        ...(parsed.researchSchedule ?? {}),
      },
      researchWatchlist:
        Array.isArray(parsed.researchWatchlist)
          ? parsed.researchWatchlist.filter((s): s is string => typeof s === "string")
          : DEFAULT_SETTINGS.researchWatchlist,
      researchAlertConfidenceThreshold:
        typeof parsed.researchAlertConfidenceThreshold === "number"
          ? parsed.researchAlertConfidenceThreshold
          : DEFAULT_SETTINGS.researchAlertConfidenceThreshold,
      researchArxivTopics:
        Array.isArray(parsed.researchArxivTopics) && parsed.researchArxivTopics.length > 0
          ? parsed.researchArxivTopics.filter((s): s is string => typeof s === "string")
          : DEFAULT_SETTINGS.researchArxivTopics,
      // Phase 10 Heartbeat forward-compat: missing → default (disabled,
      // 30m). Older settings.json files load cleanly.
      heartbeat: {
        ...DEFAULT_SETTINGS.heartbeat,
        ...(parsed.heartbeat ?? {}),
      },
      // Web Capability forward-compat: missing → default (no keys). Older
      // settings.json files (pre-web) load cleanly.
      apiKeys: {
        ...DEFAULT_SETTINGS.apiKeys,
        ...(parsed.apiKeys ?? {}),
      },
      // Phase 7-C forward-compat: missing → default (no key, Cassius voice).
      // Older settings.json files (pre-ElevenLabs) load cleanly.
      elevenlabs: {
        ...DEFAULT_SETTINGS.elevenlabs,
        ...(parsed.elevenlabs ?? {}),
      },
      // v2.4.2 Phase A forward-compat: missing → local defaults. Older
      // settings.json files (pre-backend-switch) load cleanly. Enum-guarded so
      // a malformed value can never select a non-existent backend.
      inferenceBackend: parsed.inferenceBackend === "nous" ? "nous" : "local",
      perPersonaBackend: { ...(parsed.perPersonaBackend ?? {}) },
      // Gate 2 forward-compat: missing → {} (all personas redacted). Each value
      // is enum-guarded so a malformed entry can never silently become "full"
      // (fail safe — anything not exactly "full" reads as redacted at resolve
      // time, and we drop non-"full" stray values on load).
      cloudDataPolicy: sanitizeCloudPolicy(parsed.cloudDataPolicy),
      nousApiKey:
        parsed.nousApiKey === undefined
          ? DEFAULT_SETTINGS.nousApiKey
          : parsed.nousApiKey,
      useReboundModels: parsed.useReboundModels === true,
      // Tool-call enablement forward-compat: missing/blank/retired → default
      // (hermes3:8b). Older settings.json files load cleanly.
      toolExecutionModel: normalizeToolExecutionModel(parsed.toolExecutionModel),
      // Stage 10 forward-compat: missing → no endpoints. Older files load cleanly.
      fleet: {
        endpoints: Array.isArray(parsed.fleet?.endpoints)
          ? parsed.fleet.endpoints
          : DEFAULT_SETTINGS.fleet.endpoints,
      },
      // G2 forward-compat: missing → {} (every role follows detected tier).
      perRoleTierOverride:
        parsed.perRoleTierOverride && typeof parsed.perRoleTierOverride === "object"
          ? (parsed.perRoleTierOverride as Record<string, "lean" | "mid" | "ample">)
          : DEFAULT_SETTINGS.perRoleTierOverride,
      // Stage 3 forward-compat: missing → no creds. Older files load cleanly.
      gmail: {
        clientId: parsed.gmail?.clientId ?? DEFAULT_SETTINGS.gmail.clientId,
        clientSecret: parsed.gmail?.clientSecret ?? DEFAULT_SETTINGS.gmail.clientSecret,
        refreshToken: parsed.gmail?.refreshToken ?? DEFAULT_SETTINGS.gmail.refreshToken,
      },
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_SETTINGS };
    }
    throw e;
  }
}

export type SettingsPatch = Partial<
  Omit<PersistedSettings, "version" | "updatedAt">
>;

// ---- POSTURE RULE (owner ruling, 2026-06-12) -------------------------------
// Self-heal targets SILENT DRIFT only — a persisted pointer at a retired/
// broken model (normalizeDefaultModel / normalizeToolExecutionModel above) is
// repaired because no operator chose it. DELIBERATE, AUTHENTICATED operator
// changes STAND: backend/cloud-posture fields (inferenceBackend,
// perPersonaBackend, cloudDataPolicy, nousApiKey) are session-authed at the
// API route, audited old→new below, and warned about in the UI (the FULL
// policy keeps its orange banner) — they are NEVER silently reverted or
// "normalized" by readSettings. If a posture value on disk is wrong, the
// adjudication evidence is the settings.changed value log, not a guess.
// -----------------------------------------------------------------------------

// Keys whose VALUES are recorded old→new in the settings.changed audit entry.
// Posture-relevant enums/flags must be value-adjudicable from the chain (the
// 2026-06-08/11 drift incident was unadjudicable because only key NAMES were
// logged). Secret-bearing keys are NEVER value-logged — they record a
// configured/cleared transition instead.
const VALUE_LOGGED_KEYS = new Set<string>([
  "inferenceBackend",
  "perPersonaBackend",
  "cloudDataPolicy",
  "useReboundModels",
  "requirePin",
  "defaultPersona",
  "defaultModel",
  "toolExecutionModel",
]);
const SECRET_KEYS = new Set<string>([
  "nousApiKey",
  "operatorPinHash",
  "operatorPushoverUserKey",
  "operatorPushoverApiToken",
  "twilioAccountSid",
  "twilioAuthToken",
  "apiKeys",
  "elevenlabs",
  "gmail",
]);

function describeChange(
  key: string,
  from: unknown,
  to: unknown
): { from: unknown; to: unknown } {
  if (SECRET_KEYS.has(key)) {
    // Presence transition only — never the value (even ciphertext).
    const state = (v: unknown) =>
      v === null || v === undefined || v === "" ? "unset" : "configured";
    return { from: state(from), to: state(to) };
  }
  if (VALUE_LOGGED_KEYS.has(key)) {
    return { from: from ?? null, to: to ?? null };
  }
  // Non-posture, non-secret structured config (fleet, researchSchedule, …):
  // key-level record only, values elided to keep entries small.
  return { from: "(value elided)", to: "(value elided)" };
}

// In-process write mutex. writeSettings is read-modify-write; two concurrent
// saves (the Settings UI fires one POST per click) could interleave and drop
// one patch — the suspected mechanism behind the 2026-06-11 lost
// perPersonaBackend correction. Serialize like appendAudit (lib/audit.ts).
let writeQueue: Promise<unknown> = Promise.resolve();

export function writeSettings(patch: SettingsPatch): Promise<PersistedSettings> {
  const run = writeQueue.then(() => writeSettingsUnlocked(patch));
  writeQueue = run.catch(() => {
    /* keep the queue alive past a failed write */
  });
  return run;
}

async function writeSettingsUnlocked(
  patch: SettingsPatch
): Promise<PersistedSettings> {
  const current = await readSettings();
  const next: PersistedSettings = {
    ...current,
    ...patch,
    version: SETTINGS_VERSION,
    updatedAt: Date.now(),
  };

  // R1 settings-guard (Phase 7 ruling, 2026-06-10): requirePin=true with NO
  // operatorPinHash configured is an UNREACHABLE-OPERATOR state — every chat
  // is forced to guest (isOperator = !requirePin || validToken, and no token
  // can ever be minted without a PIN to verify against), so memory/operator
  // mode are silently dead. Reject the TRANSITION INTO that state.
  //
  // Scope (fixed 2026-06-10): only guard when THIS patch touches the auth
  // fields (requirePin or operatorPinHash). A pre-existing bad state on disk
  // must NOT block unrelated writes (e.g. changing defaultPersona) — otherwise
  // the settings endpoint bricks until the operator happens to fix auth, and
  // they can't even change other settings to do it. The guard stops the
  // operator from CREATING the bad state, not from editing around one.
  const touchesAuth =
    patch.requirePin !== undefined || patch.operatorPinHash !== undefined;
  const willRequirePin = next.requirePin === true;
  const willHavePin =
    typeof next.operatorPinHash === "string" && next.operatorPinHash.length > 0;
  if (touchesAuth && willRequirePin && !willHavePin) {
    throw new Error(
      "requirePin=true requires an operatorPinHash to be set — without a PIN no operator session can ever be minted and every turn runs as guest (unreachable-operator state). Set a PIN, or leave requirePin=false."
    );
  }
  await fsp.mkdir(configDir(), { recursive: true });
  // Atomic write: write to a per-pid temp file in the same dir, fsync,
  // then rename over the target. If the process is killed (or the USB
  // is yanked) mid-write, the worst case is an orphaned .tmp file —
  // settings.json itself is either the previous valid version or the
  // new one, never partial.
  //
  // Filed as Gap A in methodology/threat-model-audit.md after the H8.5
  // audit. Same place needed protection during the H8.5 NTFS-corruption-
  // from-yank-during-write incident; this brings settings up to the
  // same posture.
  const finalPath = settingsPath();
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const payload = JSON.stringify(next, null, 2);
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(payload, "utf8");
    // fsync forces the write to disk before we rename, so the rename
    // can't make a stale-content file visible to readers.
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmpPath, finalPath);

  // Phase 4 audit: record settings change. Best-effort — audit append
  // failure does NOT roll back the settings write (settings is the
  // authoritative store; audit is the receipt).
  //
  // 2026-06-12 (owner ruling): the entry records old→new VALUES for
  // posture-relevant keys (see VALUE_LOGGED_KEYS) so drift is adjudicable
  // from the chain. Secrets record configured/unset transitions only.
  try {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(patch)) {
      changes[key] = describeChange(
        key,
        (current as unknown as Record<string, unknown>)[key],
        (next as unknown as Record<string, unknown>)[key]
      );
    }
    await appendAudit("settings.changed", {
      changed: Object.keys(patch),
      changes,
      defaultPersona: next.defaultPersona,
      defaultModel: next.defaultModel,
    });
  } catch (auditErr) {
    console.warn(
      `[settings] audit append failed (non-fatal): ${
        (auditErr as Error).message
      }`
    );
  }

  return next;
}
