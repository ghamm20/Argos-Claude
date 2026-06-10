// lib/chat/boot.ts
//
// Phase 2 (2026-06-10) — chat-orchestrator extraction. Module-level boot
// kickers moved VERBATIM from app/api/chat/route.ts. Importing this module
// (route.ts does, for side effects) runs them once per process lifetime —
// identical timing to the pre-extraction behavior, where they ran when the
// route module first loaded.

import { initMemoryStore } from "@/lib/memory/store";
import { ensureSchedulerStarted } from "@/lib/research/scheduler";
import { ensureHeartbeatStarted } from "@/lib/heartbeat";
import { ensureTaskSchedulerStarted } from "@/lib/task-scheduler";
import { ensureLoopSchedulerStarted } from "@/lib/loops/scheduler";

// Module-level init kicker — runs once per process lifetime when this
// module first loads. Best-effort: failures here just mean the first
// memory write will run init lazily anyway (initMemoryStore is
// idempotent). Fire-and-forget.
void initMemoryStore().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[chat] memory store init failed (will retry lazily): ${
      (e as Error).message
    }`
  );
});

// Phase 11 — scheduler boot. Reads settings + starts the background
// timers when settings.researchSchedule.enabled is true. No-op when
// the operator hasn't enabled the scheduler. Idempotent.
void ensureSchedulerStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[chat] scheduler boot failed: ${(e as Error).message}`
  );
});

// Phase 10 Heartbeat — boot the ambient dispatcher. No-op when
// settings.heartbeat.enabled is false. Idempotent.
void ensureHeartbeatStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(`[chat] heartbeat boot failed: ${(e as Error).message}`);
});

// Overnight Engine — boot the task scheduler. No-op work until a task is
// dropped into ARGOS_ROOT/tasks/queue/. Idempotent.
void ensureTaskSchedulerStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(`[chat] task scheduler boot failed: ${(e as Error).message}`);
});

// Self-Evolving Loop Suite — boot the loop scheduler. Dormant unless a
// scheduled loop's window is hit (and ARGOS_LOOPS_AUTORUN is on). Idempotent.
void ensureLoopSchedulerStarted().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn(`[chat] loop scheduler boot failed: ${(e as Error).message}`);
});
