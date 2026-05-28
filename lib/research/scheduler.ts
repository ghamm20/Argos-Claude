// lib/research/scheduler.ts
//
// Phase 11 — background research scheduler. Module-scope setInterval
// timers fire scheduled streams (weather, news, ai_updates, arxiv)
// at the cadence configured in settings.researchSchedule. Singleton:
// ensureSchedulerStarted() reads settings on first call and starts
// all enabled timers; subsequent calls are no-ops while the timers
// are alive.
//
// Per-tick behaviour:
//   - skip if isInFlight() — never compete with a chat request
//   - skip if settings.researchSchedule.enabled is now false
//     (operator toggled it off after start)
//   - run the canonical query for the stream (e.g. "weather Atlanta")
//   - call afterReport() to write memory + send alerts
//   - persist last-fired time + count to schedule.json
//
// State on disk: data/research/schedule.json — last-fired and
// run-count per stream. Reset on next ARGOS_DATA_DIR boot if the
// file is missing.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { readSettings } from "../settings";
import { runResearch } from "./index";
import { afterReport } from "./afterReport";
import { isInFlight } from "../chat/inflight";
import { pruneOldResearchMemories } from "./memory";

// ----- types -----

type StreamKey = "weather" | "news" | "ai_updates" | "arxiv";

const STREAM_QUERIES: Record<StreamKey, string[]> = {
  // For locationed streams the planner fires per-home-market when
  // location is unset; we hand a single un-located query.
  weather: ["weather Atlanta and Orlando"],
  news: ["latest local news"],
  ai_updates: ["latest AI news and model releases"],
  arxiv: ["arxiv papers this week"],
};

interface ScheduleState {
  startedAt: string | null;
  lastFiredAt: Partial<Record<StreamKey, string>>;
  runCount: Partial<Record<StreamKey, number>>;
  skippedInFlight: Partial<Record<StreamKey, number>>;
  failureCount: Partial<Record<StreamKey, number>>;
}

const EMPTY_STATE: ScheduleState = {
  startedAt: null,
  lastFiredAt: {},
  runCount: {},
  skippedInFlight: {},
  failureCount: {},
};

// ----- paths -----

function researchDir(): string {
  if (process.env.ARGOS_DATA_DIR && process.env.ARGOS_DATA_DIR.length > 0) {
    return path.join(process.env.ARGOS_DATA_DIR, "research");
  }
  return path.join(argosRoot(), "data", "research");
}

function statePath(): string {
  return path.join(researchDir(), "schedule.json");
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(researchDir(), { recursive: true });
}

async function readState(): Promise<ScheduleState> {
  try {
    const raw = await fsp.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ScheduleState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE };
    return { ...EMPTY_STATE };
  }
}

async function writeState(s: ScheduleState): Promise<void> {
  await ensureDir();
  const final = statePath();
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

// ----- module-scope timer registry -----

interface ActiveTimer {
  handle: NodeJS.Timeout;
  intervalMs: number;
  stream: StreamKey;
}

let timers: ActiveTimer[] = [];
let starting = false;
let runningTick: Promise<void> | null = null;

/** Public diagnostics — used by the schedule API route + Tools UI. */
export async function getSchedulerStatus(): Promise<{
  running: boolean;
  startedAt: string | null;
  activeStreams: Array<{ stream: StreamKey; intervalMinutes: number }>;
  state: ScheduleState;
}> {
  const state = await readState();
  return {
    running: timers.length > 0,
    startedAt: state.startedAt,
    activeStreams: timers.map((t) => ({
      stream: t.stream,
      intervalMinutes: Math.round(t.intervalMs / 60000),
    })),
    state,
  };
}

/**
 * Idempotent start. Reads settings; sets up timers for each enabled
 * stream (interval > 0 AND settings.researchSchedule.enabled). Returns
 * the streams that started.
 */
export async function ensureSchedulerStarted(): Promise<StreamKey[]> {
  if (starting) return [];
  starting = true;
  try {
    if (timers.length > 0) return timers.map((t) => t.stream);
    const s = await readSettings().catch(() => null);
    if (!s || !s.researchSchedule.enabled) return [];

    const cfg = s.researchSchedule;
    const planRaw: Array<{ stream: StreamKey; minutes: number }> = [
      { stream: "weather", minutes: cfg.weatherMinutes },
      { stream: "news", minutes: cfg.newsMinutes },
      { stream: "ai_updates", minutes: cfg.aiUpdatesMinutes },
      { stream: "arxiv", minutes: cfg.arxivMinutes },
    ];
    const plan = planRaw.filter((p) => p.minutes > 0);

    const started: StreamKey[] = [];
    for (const { stream, minutes } of plan) {
      const intervalMs = minutes * 60_000;
      const handle = setInterval(() => {
        // Fire-and-forget tick. Each tick caps itself; the active-tick
        // singleton avoids overlapping work if a previous tick is
        // still running (e.g. ai_updates query taking 30s while the
        // next 2-minute fire would otherwise pile on).
        if (runningTick) return;
        runningTick = tick(stream).finally(() => {
          runningTick = null;
        });
      }, intervalMs);
      // Don't keep the Node event loop alive solely for this timer —
      // server lifecycle owns the process.
      if (typeof handle.unref === "function") handle.unref();
      timers.push({ handle, intervalMs, stream });
      started.push(stream);
    }

    const state = await readState();
    state.startedAt = new Date().toISOString();
    await writeState(state);
    return started;
  } finally {
    starting = false;
  }
}

/** Stop all timers + clear registry. Idempotent. */
export async function stopScheduler(): Promise<void> {
  for (const t of timers) clearInterval(t.handle);
  timers = [];
}

/** One tick of one stream. Honored by the wrapper in ensureSchedulerStarted. */
async function tick(stream: StreamKey): Promise<void> {
  // Honor the in-flight gate so the scheduler never fires during an
  // active chat request.
  if (isInFlight()) {
    const state = await readState();
    state.skippedInFlight[stream] = (state.skippedInFlight[stream] ?? 0) + 1;
    await writeState(state).catch(() => {});
    return;
  }
  // Re-check settings every tick — operator may have toggled
  // schedulerEnabled off; honor immediately.
  const s = await readSettings().catch(() => null);
  if (!s || !s.researchSchedule.enabled) {
    return;
  }

  const queries = STREAM_QUERIES[stream];
  if (!queries || queries.length === 0) return;

  for (const q of queries) {
    try {
      const report = await runResearch(q, "bartimaeus");
      if (!report) continue;
      // Memory + alerts. Failures are logged inside afterReport
      // and don't surface here.
      await afterReport(report, "bartimaeus");
      const state = await readState();
      state.lastFiredAt[stream] = new Date().toISOString();
      state.runCount[stream] = (state.runCount[stream] ?? 0) + 1;
      await writeState(state).catch(() => {});
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[research/scheduler] tick ${stream} threw: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      const state = await readState();
      state.failureCount[stream] = (state.failureCount[stream] ?? 0) + 1;
      await writeState(state).catch(() => {});
    }
  }
  // Opportunistic memory prune — keeps the short_term tier from
  // ballooning over weeks of scheduled runs.
  await pruneOldResearchMemories("bartimaeus").catch(() => {});
}

/** Force one tick of a given stream (used by tests / "Run scheduler
 *  tick" UI). Bypasses the interval but honors in-flight. */
export async function tickStreamOnce(stream: StreamKey): Promise<void> {
  await tick(stream);
}

/** Test-only: clear in-memory state without touching disk. */
export function _resetSchedulerForTests(): void {
  for (const t of timers) clearInterval(t.handle);
  timers = [];
  starting = false;
  runningTick = null;
}

export type { StreamKey };

/** Verify state file path — used by the schedule API route to
 *  surface the location to the operator. */
export function schedulerStateFile(): string {
  return statePath();
}

/** Read just the persisted state (no timer touch). */
export async function getScheduleState(): Promise<ScheduleState> {
  return readState();
}
