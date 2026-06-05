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

export async function writeSettings(
  patch: SettingsPatch
): Promise<PersistedSettings> {
  const current = await readSettings();
  const next: PersistedSettings = {
    ...current,
    ...patch,
    version: SETTINGS_VERSION,
    updatedAt: Date.now(),
  };
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
  try {
    await appendAudit("settings.changed", {
      changed: Object.keys(patch),
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
