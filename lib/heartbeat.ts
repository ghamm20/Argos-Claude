// lib/heartbeat.ts
//
// Phase 10 Heartbeat (2026-05-31) — ambient autonomous dispatcher.
//
// OpenClaw-inspired heartbeat: ARGOS wakes on a configurable interval,
// reads a HEARTBEAT.md checklist, asks the fast triage model (Bobby)
// whether anything needs the operator's attention, and fires a Pushover
// alert ONLY when something is actionable. Silent otherwise. This is
// the layer where ARGOS acts without being prompted.
//
// Studied from OpenClaw's heartbeat + channel routing pattern; built
// natively in TypeScript. No Python, no new external services, no host
// install. Everything under ARGOS_ROOT. (Same approach as the Phase 9
// AgenticSeek router.)
//
// Reuses the Phase 11 infrastructure rather than re-implementing it:
//   - pushoverSend()  (lib/research/alerts.ts) for delivery
//   - isInFlight()    (lib/chat/inflight.ts) so a tick never competes
//                     with an active chat
//   - the scheduler.ts singleton pattern (setInterval + unref +
//     active-tick guard + atomic state writes)
//
// Doctrine:
//   - GRACEFUL. If Ollama is down, the tick is skipped cleanly, logged,
//     and recorded as an error — ARGOS never crashes.
//   - NON-BLOCKING. Runs entirely in the background; never touches the
//     UI/chat request path.
//   - SILENT BY DEFAULT. No checklist / HEARTBEAT_OK / disabled → no
//     alert. Alerts fire only on a genuine actionable triage result.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import { readSettings } from "./settings";
import { getOllamaBase } from "./ollama-config";
import { isInFlight } from "./chat/inflight";
// Phase 11 Dispatcher — an actionable heartbeat item is passed to the
// dispatcher (classify → route → memory → alert) instead of alerting
// directly. The dispatcher reuses the same pushoverSend primitive.
import { dispatchEvent } from "./dispatcher";
import { PERSONA_BY_ID } from "./personas";
// Overnight Engine (2026-06-02) — the heartbeat tick also pumps the task queue
// (per directive: "extends the heartbeat tick"). Fire-and-forget + guarded, so
// it never blocks or competes with the heartbeat's own work. The dedicated
// task scheduler runs this on its own interval too; the pump is idempotent.
import { pumpTaskQueue } from "./task-scheduler";

// ----- constants -----

/** The marker Bobby returns when nothing needs attention. */
export const HEARTBEAT_OK_MARKER = "HEARTBEAT_OK";

const TRIAGE_TIMEOUT_MS = 30_000;

const TRIAGE_SYSTEM = [
  "You are ARGOS's heartbeat triage. A security operator has a checklist.",
  "Review it against the current context. Decide if ANYTHING needs the",
  "operator's attention RIGHT NOW.",
  "",
  `If nothing needs attention, reply with EXACTLY this and nothing else: ${HEARTBEAT_OK_MARKER}`,
  "If something needs attention, reply with a short, specific, actionable",
  "summary (what + why + suggested next step). No preamble, no pleasantries.",
  "Be conservative: only flag things that are genuinely actionable now.",
].join("\n");

// ----- types -----

export type HeartbeatStatus =
  | "ok" // model returned HEARTBEAT_OK → suppressed
  | "actionable" // model flagged something → alert built
  | "skipped_empty" // HEARTBEAT.md present but blank
  | "skipped_inflight" // a chat was in progress
  | "skipped_disabled" // heartbeat disabled in settings
  | "error"; // triage failed (e.g. Ollama down)

export interface HeartbeatAlertPayload {
  title: string;
  message: string;
  fired: boolean; // did pushoverSend actually deliver?
  reason: string; // delivery reason (e.g. "not configured")
}

export interface HeartbeatResult {
  at: string; // ISO timestamp of the tick
  source: "interval" | "manual" | "boot";
  status: HeartbeatStatus;
  checklistPresent: boolean;
  modelUsed: string | null;
  triageSnippet: string | null; // first ~240 chars of the model reply
  alert: HeartbeatAlertPayload | null;
  reason: string;
  durationMs: number;
}

interface HeartbeatCounts {
  ticks: number;
  ok: number;
  actionable: number;
  skipped: number;
  errors: number;
  alertsFired: number;
}

interface HeartbeatState {
  startedAt: string | null;
  lastTickAt: string | null;
  intervalMinutes: number;
  last: HeartbeatResult | null;
  counts: HeartbeatCounts;
}

const EMPTY_STATE: HeartbeatState = {
  startedAt: null,
  lastTickAt: null,
  intervalMinutes: 30,
  last: null,
  counts: { ticks: 0, ok: 0, actionable: 0, skipped: 0, errors: 0, alertsFired: 0 },
};

// ----- paths -----

/** ARGOS_ROOT/HEARTBEAT.md — the operator's checklist. */
export function heartbeatFilePath(): string {
  return path.join(argosRoot(), "HEARTBEAT.md");
}

/** ARGOS_ROOT/state/heartbeat-state.json — persisted tick state. */
export function heartbeatStatePath(): string {
  return path.join(argosRoot(), "state", "heartbeat-state.json");
}

async function ensureStateDir(): Promise<void> {
  await fsp.mkdir(path.dirname(heartbeatStatePath()), { recursive: true });
}

async function readState(): Promise<HeartbeatState> {
  try {
    const raw = await fsp.readFile(heartbeatStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<HeartbeatState>;
    return {
      ...EMPTY_STATE,
      ...parsed,
      counts: { ...EMPTY_STATE.counts, ...(parsed.counts ?? {}) },
    };
  } catch {
    // Missing/corrupt → fresh state. Never throw from here.
    return { ...EMPTY_STATE, counts: { ...EMPTY_STATE.counts } };
  }
}

async function writeState(s: HeartbeatState): Promise<void> {
  // Atomic temp+fsync+rename, mirroring scheduler.ts / settings.ts.
  await ensureStateDir();
  const final = heartbeatStatePath();
  const tmp = `${final}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(s, null, 2), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
}

// ----- checklist read -----

/** Read HEARTBEAT.md. Returns { present, content }. `present:false`
 *  when the file is missing. Content is the raw text (may be blank). */
async function readChecklist(): Promise<{ present: boolean; content: string }> {
  try {
    const content = await fsp.readFile(heartbeatFilePath(), "utf8");
    return { present: true, content };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, content: "" };
    }
    // Unreadable for another reason → treat as absent but log.
    // eslint-disable-next-line no-console
    console.warn(
      `[heartbeat] HEARTBEAT.md unreadable: ${e instanceof Error ? e.message : String(e)}`
    );
    return { present: false, content: "" };
  }
}

// ----- triage -----

/** Classify a triage reply. HEARTBEAT_OK (as a standalone marker) ⇒
 *  "ok"; anything else ⇒ "actionable". */
export function classifyTriage(reply: string): "ok" | "actionable" {
  const trimmed = (reply ?? "").trim();
  if (trimmed.length === 0) return "ok"; // empty reply = nothing to say
  // Treat a reply that is essentially just the marker as OK. We accept
  // the marker appearing anywhere as the "all clear" signal, but only
  // when the reply is short (a long reply that happens to mention the
  // marker alongside real content is actionable).
  const upper = trimmed.toUpperCase();
  if (upper === HEARTBEAT_OK_MARKER) return "ok";
  if (trimmed.length <= 64 && upper.includes(HEARTBEAT_OK_MARKER)) return "ok";
  return "actionable";
}

/** Build the operator-facing alert from an actionable triage reply. */
export function buildHeartbeatAlert(triageReply: string): {
  title: string;
  message: string;
} {
  const body = triageReply.trim();
  return {
    title: "⚠ ARGOS Heartbeat — action needed",
    message: body.length > 0 ? body : "Heartbeat flagged an item (no detail).",
  };
}

/** Resolve the triage model — Bobby (fastest), falling back to the
 *  configured default model if Bobby isn't registered. */
function triageModel(defaultModel: string): string {
  const bobby = PERSONA_BY_ID["bobby"];
  return bobby?.model || defaultModel;
}

/**
 * Ask the triage model to review the checklist. Returns the raw reply
 * text. THROWS on transport/timeout/non-200 so the caller can record a
 * clean "error" status (e.g. Ollama down) without crashing.
 */
async function triageWithModel(
  model: string,
  checklist: string,
  contextNote: string
): Promise<string> {
  const userMsg = [
    "CHECKLIST:",
    checklist.trim().length > 0 ? checklist.trim() : "(no checklist file present)",
    "",
    "CONTEXT:",
    contextNote,
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIAGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: TRIAGE_SYSTEM },
          { role: "user", content: userMsg },
        ],
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 256 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`ollama ${res.status}: ${errText.slice(0, 200)}`);
    }
    const j = (await res.json()) as { message?: { content?: string } };
    return (j.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

// ----- the tick -----

let runningTick: Promise<HeartbeatResult> | null = null;

/**
 * Run one heartbeat tick. Total/graceful: never throws. Returns a
 * HeartbeatResult describing what happened.
 *
 * opts.triageOverride — TEST HOOK: bypass the Ollama call and use this
 *   string as the model reply (lets the smoke test the decision +
 *   alert-payload paths deterministically without a live model).
 */
export async function runHeartbeatTick(
  opts: { source?: "interval" | "manual" | "boot"; triageOverride?: string } = {}
): Promise<HeartbeatResult> {
  // Serialize: if a tick is already running, await it rather than
  // overlapping (mirrors scheduler's active-tick guard).
  if (runningTick) return runningTick;
  // Overnight Engine — pump the task queue on every heartbeat tick (background,
  // guarded, never blocks the heartbeat or the UI).
  void pumpTaskQueue().catch(() => {});
  runningTick = (async () => {
    const start = Date.now();
    const source = opts.source ?? "manual";
    const at = new Date().toISOString();
    const base = (
      status: HeartbeatStatus,
      reason: string,
      extra: Partial<HeartbeatResult> = {}
    ): HeartbeatResult => ({
      at,
      source,
      status,
      checklistPresent: false,
      modelUsed: null,
      triageSnippet: null,
      alert: null,
      reason,
      durationMs: Date.now() - start,
      ...extra,
    });

    let result: HeartbeatResult;
    try {
      // 1) In-flight gate — never compete with an active chat.
      if (isInFlight()) {
        result = base("skipped_inflight", "a chat was in progress");
      } else {
        const settings = await readSettings().catch(() => null);
        // 2) Disabled gate (manual triggers still run even if disabled,
        //    so the test endpoint works; interval ticks honor the flag).
        if (source === "interval" && (!settings || !settings.heartbeat.enabled)) {
          result = base("skipped_disabled", "heartbeat disabled in settings");
        } else {
          const { present, content } = await readChecklist();
          const trimmed = content.trim();
          // 3) Empty checklist (present but blank) → skip silently.
          if (present && trimmed.length === 0) {
            result = base("skipped_empty", "HEARTBEAT.md is empty", {
              checklistPresent: true,
            });
          } else {
            // 4) Run triage. Missing file → still run ("model decides"
            //    per directive Task 4); the model gets a "no checklist"
            //    note and will almost always reply HEARTBEAT_OK.
            const model = triageModel(settings?.defaultModel ?? "");
            let reply: string;
            if (opts.triageOverride !== undefined) {
              reply = opts.triageOverride;
            } else {
              const contextNote = `Heartbeat tick at ${at}. ${
                present ? "Checklist loaded." : "No HEARTBEAT.md found."
              }`;
              reply = await triageWithModel(model, content, contextNote);
            }
            const snippet = reply.trim().slice(0, 240) || null;
            const decision = classifyTriage(reply);
            if (decision === "ok") {
              result = base("ok", "HEARTBEAT_OK — nothing actionable", {
                checklistPresent: present,
                modelUsed: model,
                triageSnippet: snippet,
              });
            } else {
              // 5) Actionable → pass to the Phase 11 dispatcher BEFORE
              //    alerting (per directive). The dispatcher classifies the
              //    flagged item, routes it to the right persona, logs it to
              //    Markdown memory (MEMORY.md + daily log), and fires the
              //    Pushover alert. We thread the triage text through as the
              //    persona response (responseOverride) so no second model
              //    call is made. The heartbeat's `alert` mirrors the
              //    dispatcher's delivery. dispatchEvent is total (never
              //    throws); the `?? fallback` covers the unlikely null-alert
              //    case so an actionable item is never silently dropped.
              const dispatch = await dispatchEvent(
                { type: "heartbeat", content: reply, source: "heartbeat" },
                { responseOverride: reply }
              );
              const alert =
                dispatch.alert ?? {
                  title: buildHeartbeatAlert(reply).title,
                  message: reply.trim(),
                  fired: false,
                  reason: dispatch.reason,
                };
              result = base("actionable", "actionable item flagged → dispatched", {
                checklistPresent: present,
                modelUsed: model,
                triageSnippet: snippet,
                alert,
              });
            }
          }
        }
      }
    } catch (e) {
      // Graceful: Ollama down / any failure → clean error result.
      // eslint-disable-next-line no-console
      console.warn(
        `[heartbeat] tick error (degraded, ARGOS unaffected): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      result = base(
        "error",
        `tick failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // Persist state (best-effort; never throws out of the tick).
    try {
      const state = await readState();
      state.lastTickAt = result.at;
      state.last = result;
      state.counts.ticks += 1;
      if (result.status === "ok") state.counts.ok += 1;
      else if (result.status === "actionable") state.counts.actionable += 1;
      else if (result.status === "error") state.counts.errors += 1;
      else state.counts.skipped += 1;
      if (result.alert?.fired) state.counts.alertsFired += 1;
      await writeState(state);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[heartbeat] state persist failed (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }

    return result;
  })().finally(() => {
    runningTick = null;
  });
  return runningTick;
}

// ----- singleton scheduler -----

let timer: NodeJS.Timeout | null = null;
let intervalMs = 0;
let starting = false;

/**
 * Idempotent start. Reads settings; if heartbeat.enabled, sets up the
 * interval timer (unref'd so it never keeps the process alive on its
 * own). No-op if already running or disabled.
 */
export async function ensureHeartbeatStarted(): Promise<boolean> {
  if (starting) return timer !== null;
  starting = true;
  try {
    if (timer !== null) return true;
    const s = await readSettings().catch(() => null);
    if (!s || !s.heartbeat.enabled) return false;
    const minutes = Math.max(1, Math.round(s.heartbeat.intervalMinutes || 30));
    intervalMs = minutes * 60_000;
    timer = setInterval(() => {
      // Fire-and-forget interval tick. runHeartbeatTick self-serializes.
      void runHeartbeatTick({ source: "interval" }).catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();

    const state = await readState();
    state.startedAt = new Date().toISOString();
    state.intervalMinutes = minutes;
    await writeState(state).catch(() => {});
    return true;
  } finally {
    starting = false;
  }
}

/** Stop the heartbeat timer. Idempotent. */
export function stopHeartbeat(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Diagnostics for /api/heartbeat/status + the HUD. */
export async function getHeartbeatStatus(): Promise<{
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  startedAt: string | null;
  lastTickAt: string | null;
  nextTickAt: string | null;
  last: HeartbeatResult | null;
  counts: HeartbeatCounts;
  stateFile: string;
  checklistFile: string;
}> {
  const settings = await readSettings().catch(() => null);
  const state = await readState();
  const enabled = settings?.heartbeat.enabled ?? false;
  const intervalMinutes =
    settings?.heartbeat.intervalMinutes ?? state.intervalMinutes ?? 30;
  // nextTickAt: last tick (or start) + interval, while running.
  let nextTickAt: string | null = null;
  if (timer !== null) {
    const anchor = state.lastTickAt ?? state.startedAt;
    if (anchor) {
      const t = Date.parse(anchor);
      if (Number.isFinite(t)) {
        nextTickAt = new Date(t + intervalMinutes * 60_000).toISOString();
      }
    }
  }
  return {
    enabled,
    running: timer !== null,
    intervalMinutes,
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    nextTickAt,
    last: state.last,
    counts: state.counts,
    stateFile: heartbeatStatePath(),
    checklistFile: heartbeatFilePath(),
  };
}

/** Test-only reset. */
export function _resetHeartbeatForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  intervalMs = 0;
  starting = false;
  runningTick = null;
}
