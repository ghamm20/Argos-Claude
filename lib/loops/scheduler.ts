// lib/loops/scheduler.ts
//
// Self-Evolving Loop Suite (2026-06-02) — the loop scheduler singleton.
//
// Mirrors the heartbeat / task-scheduler pattern: setInterval + unref +
// active-tick guard + atomic state writes + idempotent start. On each tick it
// checks every scheduled loop's window (nightly 2AM, Sunday 3AM, Friday 11PM,
// Saturday 2AM) and runs it once per day at/after the window — exactly like
// the morning brief's once-per-day gate.
//
// Auto-run is gated by ARGOS_LOOPS_AUTORUN (default ON; set to "0"/"false" to
// keep the scheduler dormant and run loops only on demand via the API). Even
// when a scheduled loop fires, NOTHING is applied — high-risk proposals land in
// the trace store as "awaiting_approval" for the operator.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { isInFlight } from "../chat/inflight";
import { scheduledLoops } from "./registry";
import { runLoop } from "./orchestrator";
import { loopsStateDir } from "./trace-store";

const TICK_MS = 60_000;

export function loopsAutorunEnabled(): boolean {
  const v = (process.env.ARGOS_LOOPS_AUTORUN ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

interface LoopSchedulerState {
  startedAt: string | null;
  lastTickAt: string | null;
  lastRunDates: Record<string, string>; // loopId → YYYY-MM-DD
  counts: { ticks: number; scheduledRuns: number; errors: number };
}

const EMPTY: LoopSchedulerState = {
  startedAt: null,
  lastTickAt: null,
  lastRunDates: {},
  counts: { ticks: 0, scheduledRuns: 0, errors: 0 },
};

function statePath(): string {
  return path.join(loopsStateDir(), "scheduler-state.json");
}

async function readState(): Promise<LoopSchedulerState> {
  try {
    const raw = await fsp.readFile(statePath(), "utf8");
    const p = JSON.parse(raw) as Partial<LoopSchedulerState>;
    return {
      ...EMPTY,
      ...p,
      lastRunDates: { ...(p.lastRunDates ?? {}) },
      counts: { ...EMPTY.counts, ...(p.counts ?? {}) },
    };
  } catch {
    return { ...EMPTY, lastRunDates: {}, counts: { ...EMPTY.counts } };
  }
}

async function writeState(s: LoopSchedulerState): Promise<void> {
  await fsp.mkdir(loopsStateDir(), { recursive: true });
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

/** Is a scheduled loop due now (day matches + at/after its time + not run today)? */
function isDue(
  schedule: { dayOfWeek: number | "daily"; hour: number; minute: number },
  lastRunDate: string | undefined,
  now: Date
): boolean {
  const today = now.toISOString().slice(0, 10);
  if (lastRunDate === today) return false;
  const dayMatch = schedule.dayOfWeek === "daily" || now.getDay() === schedule.dayOfWeek;
  if (!dayMatch) return false;
  const target = new Date(now);
  target.setHours(schedule.hour, schedule.minute, 0, 0);
  return now.getTime() >= target.getTime();
}

let ticking = false;

/** One scheduler tick: run any due scheduled loops (sequential). Never throws. */
export async function loopSchedulerTick(now = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const state = await readState();
    state.lastTickAt = now.toISOString();
    state.counts.ticks += 1;

    if (loopsAutorunEnabled() && !isInFlight()) {
      for (const def of scheduledLoops()) {
        if (!def.schedule) continue;
        if (!isDue(def.schedule, state.lastRunDates[def.id], now)) continue;
        try {
          await runLoop(def, { trigger: "scheduled", sessionId: null });
          state.counts.scheduledRuns += 1;
        } catch (e) {
          state.counts.errors += 1;
          // eslint-disable-next-line no-console
          console.warn(`[loops] scheduled ${def.id} failed: ${(e as Error).message}`);
        }
        state.lastRunDates[def.id] = now.toISOString().slice(0, 10);
      }
    }
    await writeState(state).catch(() => {});
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[loops] scheduler tick error (non-fatal): ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}

// ----- singleton -----

let timer: ReturnType<typeof setInterval> | null = null;
let starting = false;

export async function ensureLoopSchedulerStarted(): Promise<boolean> {
  if (starting) return timer !== null;
  starting = true;
  try {
    if (timer !== null) return true;
    await fsp.mkdir(loopsStateDir(), { recursive: true }).catch(() => {});
    timer = setInterval(() => {
      void loopSchedulerTick().catch(() => {});
    }, TICK_MS);
    if (typeof timer.unref === "function") timer.unref();
    const state = await readState();
    state.startedAt = new Date().toISOString();
    await writeState(state).catch(() => {});
    return true;
  } finally {
    starting = false;
  }
}

export function stopLoopScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export async function getLoopSchedulerStatus(): Promise<{
  running: boolean;
  autorun: boolean;
  tickMs: number;
  startedAt: string | null;
  lastTickAt: string | null;
  lastRunDates: Record<string, string>;
  counts: LoopSchedulerState["counts"];
  windows: Array<{ id: string; label: string }>;
}> {
  const state = await readState();
  return {
    running: timer !== null,
    autorun: loopsAutorunEnabled(),
    tickMs: TICK_MS,
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    lastRunDates: state.lastRunDates,
    counts: state.counts,
    windows: scheduledLoops().map((l) => ({ id: l.id, label: l.schedule!.label })),
  };
}

/** Test-only reset. */
export function _resetLoopScheduler(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  starting = false;
  ticking = false;
}
