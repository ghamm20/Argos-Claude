// lib/loops/scheduler-hook.ts
//
// Self-Evolving Loop Suite — integrates the loop scheduler with the EXISTING
// heartbeat tick (per directive: "register all loops with existing heartbeat
// tick + scheduler"), rather than relying only on a standalone timer.
//
// The heartbeat already fires on its configured interval and pumps the task
// queue; here we add a one-line pump for due scheduled loops. The loop tick is
// idempotent per day (once-per-window gate in scheduler.ts), so firing it from
// BOTH the heartbeat AND the loop scheduler's own unref'd timer never
// double-runs a window.

import { loopSchedulerTick } from "./scheduler";
import { scheduledLoops } from "./registry";

/** Fire-and-forget: run any scheduled loop whose window is due. Called from
 *  the heartbeat tick. Never blocks, never throws. */
export function pumpScheduledLoops(): void {
  void loopSchedulerTick().catch(() => {});
}

/** Summary of which loops are registered to scheduled windows (for diagnostics
 *  + the morning brief). */
export function scheduledLoopWindows(): Array<{ id: string; label: string }> {
  return scheduledLoops().map((l) => ({ id: l.id, label: l.schedule!.label }));
}
