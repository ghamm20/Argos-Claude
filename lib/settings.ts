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
  // Phase 2 Persona Completion (2026-05-28): Bart now binds to
  // royhodge812/Orchestrator:lates (note :lates, not :latest). The
  // boot model loads this so the first chat doesn't pay a cold-swap.
  defaultModel: "royhodge812/Orchestrator:lates",
  updatedAt: 0,
  operatorPinHash: null,
  requirePin: false,
  // Phase 11 defaults: alerts disabled until operator supplies keys;
  // scheduler disabled until operator opts in. Watchlist + thresholds
  // pre-populated with sane values per the directive.
  operatorPushoverUserKey: null,
  operatorPushoverApiToken: null,
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
};

export function configDir(): string {
  return path.join(argosRoot(), "config");
}

export function settingsPath(): string {
  return path.join(configDir(), "settings.json");
}

export async function readSettings(): Promise<PersistedSettings> {
  try {
    const raw = await fsp.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      version: SETTINGS_VERSION,
      defaultPersona: parsed.defaultPersona ?? DEFAULT_SETTINGS.defaultPersona,
      defaultModel: parsed.defaultModel ?? DEFAULT_SETTINGS.defaultModel,
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
