// lib/task-scheduler.ts
//
// Overnight Engine (2026-06-02) — the scheduler singleton that drives the
// queue. On each tick it intakes new task files, claims the next eligible task
// (respecting run_at + priority), runs it in the background, and — once per day
// at the configured time — generates the morning brief.
//
// Mirrors the heartbeat/scheduler singleton pattern: setInterval + unref +
// active-pump guard + idempotent start. NON-BLOCKING: ticks are fire-and-forget
// so the runner never touches the UI/chat request path.
//
// Brief time is configurable via ARGOS_BRIEF_TIME ("HH:MM", default 06:00).

import {
  ensureTaskDirs,
  intakeQueue,
  claimNext,
  completeTask,
  failTask,
  readQueueState,
  writeQueueState,
} from "./task-queue";
import { runTask, notifyTaskResult } from "./task-runner";
import { generateMorningBrief } from "./morning-brief";

const TICK_MS = 60_000;

export function briefTime(): string {
  const v = (process.env.ARGOS_BRIEF_TIME || "06:00").trim();
  return /^\d{1,2}:\d{2}$/.test(v) ? v : "06:00";
}

let pumping = false;

/** One queue pump: intake → claim → run → archive. Runs ONE task to completion
 *  (max one at a time); never throws. Safe to call repeatedly (guarded). */
export async function pumpTaskQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    await ensureTaskDirs();
    await intakeQueue();
    const task = await claimNext();
    if (!task) return;
    const r = await runTask(task);
    if (r.failed || !r.result) {
      await failTask(task, r.error ?? "unknown failure");
      await notifyTaskResult(task, "failed", r.error ?? "task failed");
    } else {
      await completeTask(task, r.result);
      await notifyTaskResult(task, "complete", r.result.summary);
    }
    const state = await readQueueState();
    state.lastPumpAt = new Date().toISOString();
    state.counts.intaken += 1;
    await writeQueueState(state).catch(() => {});
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[task-scheduler] pump error (non-fatal): ${(e as Error).message}`);
  } finally {
    pumping = false;
  }
}

/** Fire the morning brief once per day at/after the configured time. */
export async function maybeRunMorningBrief(now = new Date()): Promise<boolean> {
  try {
    const today = now.toISOString().slice(0, 10);
    const state = await readQueueState();
    if (state.lastBriefDate === today) return false; // already ran today

    const [h, m] = briefTime().split(":").map((x) => parseInt(x, 10));
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (now.getTime() < target.getTime()) return false;

    await generateMorningBrief({ now });
    state.lastBriefDate = today;
    await writeQueueState(state).catch(() => {});
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[task-scheduler] morning brief error (non-fatal): ${(e as Error).message}`);
    return false;
  }
}

// ----- singleton -----

let timer: ReturnType<typeof setInterval> | null = null;
let starting = false;

/** Idempotent start. Always-on (the queue only acts when tasks are dropped).
 *  Booted from the chat route module init, like the heartbeat + scheduler. */
export async function ensureTaskSchedulerStarted(): Promise<boolean> {
  if (starting) return timer !== null;
  starting = true;
  try {
    if (timer !== null) return true;
    await ensureTaskDirs();
    timer = setInterval(() => {
      void (async () => {
        await pumpTaskQueue();
        await maybeRunMorningBrief();
      })().catch(() => {});
    }, TICK_MS);
    if (typeof timer.unref === "function") timer.unref();
    return true;
  } finally {
    starting = false;
  }
}

export function stopTaskScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export async function getTaskSchedulerStatus(): Promise<{
  running: boolean;
  tickMs: number;
  briefTime: string;
  lastPumpAt: string | null;
  lastBriefDate: string | null;
  runningTask: string | null;
}> {
  const state = await readQueueState();
  return {
    running: timer !== null,
    tickMs: TICK_MS,
    briefTime: briefTime(),
    lastPumpAt: state.lastPumpAt,
    lastBriefDate: state.lastBriefDate,
    runningTask: state.running,
  };
}

/** Test-only reset. */
export function _resetTaskScheduler(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  starting = false;
  pumping = false;
}
