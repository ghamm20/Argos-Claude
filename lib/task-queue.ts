// lib/task-queue.ts
//
// Overnight Engine (2026-06-02) — the task queue: a file-backed state machine.
//
//   ARGOS_ROOT/tasks/queue/        operator drops <id>.json here
//   ARGOS_ROOT/tasks/in-progress/  the one task currently running
//   ARGOS_ROOT/tasks/complete/     <id>.json + <id>-result.json  (archive)
//   ARGOS_ROOT/tasks/failed/       <id>.json + <id>-error.json   (archive)
//
// State machine: queued → running → complete | failed. Transitions are atomic
// file renames (same filesystem under ARGOS_ROOT) so a crash never corrupts a
// task. Max ONE task runs at a time. Completed/failed tasks are NEVER deleted —
// the directories are an append-only audit trail.
//
// Pure node stdlib (fs/promises, crypto, path). No new deps.

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "./vault/paths";

export type TaskPriority = "low" | "normal" | "high";
export type NotifyOn = "complete" | "error" | "both";
export type TaskStatus = "queued" | "running" | "complete" | "failed";

export interface TaskFile {
  id: string;
  goal: string;
  steps: string[]; // suggested tool ids (hints for the planner)
  priority: TaskPriority;
  run_at: string | null; // "HH:MM" or null (run immediately)
  notify_on: NotifyOn;
  dangerous_tools_allowed: boolean;
  created: string; // ISO timestamp
}

// ----- paths -----

export function tasksDir(): string {
  return path.join(argosRoot(), "tasks");
}
export function queueDir(): string {
  return path.join(tasksDir(), "queue");
}
export function inProgressDir(): string {
  return path.join(tasksDir(), "in-progress");
}
export function completeDir(): string {
  return path.join(tasksDir(), "complete");
}
export function failedDir(): string {
  return path.join(tasksDir(), "failed");
}
export function taskQueueStatePath(): string {
  return path.join(argosRoot(), "state", "task-queue-state.json");
}
export function runnerLogPath(id: string): string {
  return path.join(argosRoot(), "state", `task-runner-${safeId(id)}.log`);
}
export function resultPath(id: string): string {
  return path.join(completeDir(), `${safeId(id)}-result.json`);
}
export function errorLogPath(id: string): string {
  return path.join(failedDir(), `${safeId(id)}-error.json`);
}

function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "task";
}

export async function ensureTaskDirs(): Promise<void> {
  for (const d of [queueDir(), inProgressDir(), completeDir(), failedDir()]) {
    await fsp.mkdir(d, { recursive: true });
  }
  await fsp.mkdir(path.dirname(taskQueueStatePath()), { recursive: true });
}

// ----- validation -----

const PRIORITIES = new Set<TaskPriority>(["low", "normal", "high"]);
const NOTIFY = new Set<NotifyOn>(["complete", "error", "both"]);

/** Validate + normalize an arbitrary object into a TaskFile. */
export function validateTask(
  obj: unknown
): { ok: boolean; task?: TaskFile; error?: string } {
  if (!obj || typeof obj !== "object") return { ok: false, error: "not an object" };
  const o = obj as Record<string, unknown>;
  const goal = typeof o.goal === "string" ? o.goal.trim() : "";
  if (!goal) return { ok: false, error: "goal is required" };
  const id =
    typeof o.id === "string" && o.id.trim() ? safeId(o.id) : `task-${randomUUID().slice(0, 8)}`;
  const priority = PRIORITIES.has(o.priority as TaskPriority)
    ? (o.priority as TaskPriority)
    : "normal";
  const notify_on = NOTIFY.has(o.notify_on as NotifyOn)
    ? (o.notify_on as NotifyOn)
    : "complete";
  const steps = Array.isArray(o.steps)
    ? o.steps.filter((s): s is string => typeof s === "string").slice(0, 12)
    : [];
  let run_at: string | null = null;
  if (typeof o.run_at === "string" && /^\d{1,2}:\d{2}$/.test(o.run_at.trim())) {
    run_at = o.run_at.trim();
  }
  const task: TaskFile = {
    id,
    goal: goal.slice(0, 2000),
    steps,
    priority,
    run_at,
    notify_on,
    dangerous_tools_allowed: o.dangerous_tools_allowed === true,
    created: typeof o.created === "string" ? o.created : new Date().toISOString(),
  };
  return { ok: true, task };
}

/** Is this task due to run now? (run_at null → immediately; HH:MM → once the
 *  wall clock has passed it today.) */
export function isDue(task: TaskFile, now = new Date()): boolean {
  if (!task.run_at) return true;
  const m = task.run_at.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const target = new Date(now);
  target.setHours(h, min, 0, 0);
  return now.getTime() >= target.getTime();
}

function priorityRank(p: TaskPriority): number {
  return p === "high" ? 3 : p === "low" ? 1 : 2;
}

// ----- state -----

export interface TaskQueueState {
  running: string | null;
  lastPumpAt: string | null;
  lastBriefDate: string | null;
  counts: { intaken: number; completed: number; failed: number };
}

const EMPTY_STATE: TaskQueueState = {
  running: null,
  lastPumpAt: null,
  lastBriefDate: null,
  counts: { intaken: 0, completed: 0, failed: 0 },
};

export async function readQueueState(): Promise<TaskQueueState> {
  try {
    const raw = await fsp.readFile(taskQueueStatePath(), "utf8");
    const p = JSON.parse(raw) as Partial<TaskQueueState>;
    return { ...EMPTY_STATE, ...p, counts: { ...EMPTY_STATE.counts, ...(p.counts ?? {}) } };
  } catch {
    return { ...EMPTY_STATE, counts: { ...EMPTY_STATE.counts } };
  }
}

export async function writeQueueState(s: TaskQueueState): Promise<void> {
  await ensureTaskDirs();
  const final = taskQueueStatePath();
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

// ----- intake + listing -----

async function readJsonTasks(dir: string): Promise<Array<{ file: string; task: TaskFile }>> {
  const out: Array<{ file: string; task: TaskFile }> = [];
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter(
      (n) => n.endsWith(".json") && !n.endsWith("-result.json") && !n.endsWith("-error.json")
    );
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const raw = await fsp.readFile(path.join(dir, n), "utf8");
      const v = validateTask(JSON.parse(raw));
      if (v.ok && v.task) out.push({ file: n, task: v.task });
    } catch {
      /* skip unreadable/invalid */
    }
  }
  return out;
}

/** Validate every queued file. Invalid ones are archived to failed/ with an
 *  error log so they don't jam the queue. Returns the count newly intaken. */
export async function intakeQueue(): Promise<number> {
  await ensureTaskDirs();
  let names: string[] = [];
  try {
    names = (await fsp.readdir(queueDir())).filter((n) => n.endsWith(".json"));
  } catch {
    return 0;
  }
  let intaken = 0;
  for (const n of names) {
    const full = path.join(queueDir(), n);
    try {
      const raw = await fsp.readFile(full, "utf8");
      const v = validateTask(JSON.parse(raw));
      if (v.ok && v.task) {
        intaken++;
        // Normalize the file in place so downstream reads are clean (id
        // backfilled, defaults applied). Atomic rewrite.
        const dest = path.join(queueDir(), `${v.task.id}.json`);
        if (path.resolve(dest) !== path.resolve(full)) {
          await fsp.writeFile(dest, JSON.stringify(v.task, null, 2), "utf8");
          await fsp.rm(full, { force: true });
        }
      } else {
        await archiveInvalid(full, n, v.error ?? "invalid task");
      }
    } catch (e) {
      await archiveInvalid(full, n, (e as Error).message);
    }
  }
  return intaken;
}

async function archiveInvalid(full: string, name: string, error: string): Promise<void> {
  try {
    await fsp.mkdir(failedDir(), { recursive: true });
    const id = name.replace(/\.json$/, "");
    await fsp.writeFile(
      errorLogPath(id),
      JSON.stringify({ id, error: `invalid task: ${error}`, at: new Date().toISOString() }, null, 2),
      "utf8"
    );
    await fsp.rename(full, path.join(failedDir(), `${safeId(id)}.json`));
  } catch {
    /* best effort */
  }
}

export interface TaskListing {
  queued: TaskFile[];
  running: TaskFile[];
  complete: Array<TaskFile & { result?: unknown }>;
  failed: Array<TaskFile & { error?: unknown }>;
  runningId: string | null;
  completedToday: number;
}

export async function listAll(): Promise<TaskListing> {
  await ensureTaskDirs();
  const [q, ip, comp, fail] = await Promise.all([
    readJsonTasks(queueDir()),
    readJsonTasks(inProgressDir()),
    readJsonTasks(completeDir()),
    readJsonTasks(failedDir()),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  let completedToday = 0;
  const complete = await Promise.all(
    comp.map(async ({ task }) => {
      let result: unknown = undefined;
      try {
        result = JSON.parse(await fsp.readFile(resultPath(task.id), "utf8"));
        const at = (result as { completedAt?: string })?.completedAt;
        if (at && at.slice(0, 10) === today) completedToday++;
      } catch {
        /* no result file */
      }
      return { ...task, result };
    })
  );
  const failed = await Promise.all(
    fail.map(async ({ task }) => {
      let error: unknown = undefined;
      try {
        error = JSON.parse(await fsp.readFile(errorLogPath(task.id), "utf8"));
      } catch {
        /* no error file */
      }
      return { ...task, error };
    })
  );
  return {
    queued: q.map((x) => x.task),
    running: ip.map((x) => x.task),
    complete,
    failed,
    runningId: ip[0]?.task.id ?? null,
    completedToday,
  };
}

// ----- transitions -----

let lock: string | null = null; // in-memory single-process running lock

/** Claim the next eligible task: highest priority, oldest first, due now.
 *  Atomically moves queue/<id>.json → in-progress/<id>.json. Returns null when
 *  a task is already running or none is eligible. */
export async function claimNext(): Promise<TaskFile | null> {
  await ensureTaskDirs();
  // One at a time: in-memory lock OR a file already in in-progress.
  if (lock) return null;
  const ip = await readJsonTasks(inProgressDir());
  if (ip.length > 0) return null;

  const queued = await readJsonTasks(queueDir());
  const due = queued.filter(({ task }) => isDue(task));
  if (due.length === 0) return null;
  due.sort(
    (a, b) =>
      priorityRank(b.task.priority) - priorityRank(a.task.priority) ||
      a.task.created.localeCompare(b.task.created)
  );
  const pick = due[0];
  const from = path.join(queueDir(), pick.file);
  const to = path.join(inProgressDir(), `${pick.task.id}.json`);
  try {
    await fsp.rename(from, to);
  } catch {
    return null; // lost the race / vanished
  }
  lock = pick.task.id;
  const state = await readQueueState();
  state.running = pick.task.id;
  await writeQueueState(state).catch(() => {});
  return pick.task;
}

export async function completeTask(task: TaskFile, result: unknown): Promise<void> {
  await ensureTaskDirs();
  try {
    await fsp.writeFile(resultPath(task.id), JSON.stringify(result, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  const from = path.join(inProgressDir(), `${task.id}.json`);
  const to = path.join(completeDir(), `${task.id}.json`);
  try {
    if (existsSync(from)) await fsp.rename(from, to);
    else await fsp.writeFile(to, JSON.stringify(task, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  const state = await readQueueState();
  state.running = null;
  state.counts.completed += 1;
  await writeQueueState(state).catch(() => {});
  if (lock === task.id) lock = null;
}

export async function failTask(task: TaskFile, error: unknown): Promise<void> {
  await ensureTaskDirs();
  try {
    await fsp.writeFile(
      errorLogPath(task.id),
      JSON.stringify({ id: task.id, error, at: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch {
    /* best effort */
  }
  const from = path.join(inProgressDir(), `${task.id}.json`);
  const to = path.join(failedDir(), `${task.id}.json`);
  try {
    if (existsSync(from)) await fsp.rename(from, to);
    else await fsp.writeFile(to, JSON.stringify(task, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  const state = await readQueueState();
  state.running = null;
  state.counts.failed += 1;
  await writeQueueState(state).catch(() => {});
  if (lock === task.id) lock = null;
}

/** Cancel a QUEUED task (deletes the queue file). Running/complete/failed
 *  tasks cannot be cancelled — the archive is append-only. */
export async function cancelTask(id: string): Promise<{ ok: boolean; reason: string }> {
  const file = path.join(queueDir(), `${safeId(id)}.json`);
  if (!existsSync(file)) {
    return { ok: false, reason: "not in queue (already running/archived or unknown)" };
  }
  try {
    await fsp.rm(file, { force: true });
    return { ok: true, reason: "cancelled" };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Write a new task to the queue. Returns the normalized task. */
export async function enqueueTask(obj: unknown): Promise<{ ok: boolean; task?: TaskFile; error?: string }> {
  const v = validateTask(obj);
  if (!v.ok || !v.task) return { ok: false, error: v.error };
  await ensureTaskDirs();
  await fsp.writeFile(
    path.join(queueDir(), `${v.task.id}.json`),
    JSON.stringify(v.task, null, 2),
    "utf8"
  );
  return { ok: true, task: v.task };
}

/** Test-only: release the in-memory running lock. */
export function _resetQueueLock(): void {
  lock = null;
}
