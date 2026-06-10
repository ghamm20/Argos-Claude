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
// Phase 3 (2026-06-10) — hash-chained audit per task action + Ollama preflight.
import { appendAudit } from "./audit";
import { getOllamaBase } from "./ollama-config";

const TICK_MS = 60_000;

// ---- Ollama preflight backstop (Phase 3, owner rider 2026-06-10) ----
// The launcher watchdog (launchers/ollama-supervisor.bat) is the primary
// survival mode; this is the engine-side backstop: before claiming a task,
// health-check /api/tags. Dead → attempt ONE restart (PATH/OLLAMA_BIN ollama
// serve, detached) and wait up to 20s. Still dead → skip this tick (the task
// stays queued — never burned against a dead backend). Every preflight
// action is audited.

const PREFLIGHT_WAIT_S = 20;

async function ollamaHealthy(timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(`${getOllamaBase()}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ollamaPreflight(): Promise<boolean> {
  if (await ollamaHealthy()) return true;
  await appendAudit("task.preflight", {
    action: "ollama_down_restart_attempt",
    base: getOllamaBase(),
  }).catch(() => {});
  try {
    const { spawn } = await import("node:child_process");
    const bin = process.env.OLLAMA_BIN || "ollama";
    const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); // ENOENT etc. — the wait loop reports the outcome
    child.unref();
  } catch {
    /* spawn failed — wait loop decides */
  }
  for (let i = 0; i < PREFLIGHT_WAIT_S; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ollamaHealthy(2000)) {
      await appendAudit("task.preflight", {
        action: "ollama_restored",
        afterSeconds: i + 1,
      }).catch(() => {});
      return true;
    }
  }
  await appendAudit("task.preflight", {
    action: "ollama_unreachable_tick_skipped",
    waitedSeconds: PREFLIGHT_WAIT_S,
  }).catch(() => {});
  return false;
}

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
    // Phase 3 — preflight backstop: never claim a task against a dead Ollama.
    if (!(await ollamaPreflight())) return;
    const task = await claimNext();
    if (!task) return;
    // Phase 3 — every task action lands in the hash-chained audit log.
    await appendAudit("task.claimed", {
      taskId: task.id,
      goal: task.goal.slice(0, 200),
      priority: task.priority,
      dangerousAllowed: task.dangerous_tools_allowed,
    }).catch(() => {});
    const r = await runTask(task);
    if (r.failed || !r.result) {
      await failTask(task, r.error ?? "unknown failure");
      await appendAudit("task.failed", {
        taskId: task.id,
        error: (r.error ?? "unknown failure").slice(0, 500),
      }).catch(() => {});
      await notifyTaskResult(task, "failed", r.error ?? "task failed");
    } else {
      await completeTask(task, r.result);
      await appendAudit("task.completed", {
        taskId: task.id,
        summary: r.result.summary,
        stepsPlanned: r.result.stepsPlanned,
        stepsOk: r.result.stepsOk,
      }).catch(() => {});
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

/** Fire the morning brief once per day at/after the configured time.
 *  Phase 5 rider (owner, 2026-06-10): a scheduled PROPOSER PASS runs first —
 *  PROPOSALS ONLY (the proposer cannot execute by construction), preflight-
 *  gated like every other night task. The brief then lists the queue. */
export async function maybeRunMorningBrief(now = new Date()): Promise<boolean> {
  try {
    const today = now.toISOString().slice(0, 10);
    const state = await readQueueState();
    if (state.lastBriefDate === today) return false; // already ran today

    const [h, m] = briefTime().split(":").map((x) => parseInt(x, 10));
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (now.getTime() < target.getTime()) return false;

    // ---- scheduled proposer pass (proposals only, preflight-gated) ----
    if (await ollamaPreflight()) {
      const { generateProposals } = await import("./proposer/propose");
      const r = await generateProposals().catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[task-scheduler] scheduled proposer pass failed (non-fatal): ${(e as Error).message}`);
        return null;
      });
      if (r) {
        await appendAudit("proposal.scheduled_pass", {
          created: r.created.length,
          types: [...new Set(r.created.map((p) => p.type))],
          predictions: r.predictions.length,
          skippedBelowThreshold: r.skippedBelowThreshold,
        }).catch(() => {});
      }
    } else {
      await appendAudit("proposal.scheduled_pass", { skipped: "ollama_preflight_failed" }).catch(() => {});
    }

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
