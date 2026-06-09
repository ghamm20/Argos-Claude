// lib/tasks/store.ts
//
// Stage 2 (2026-06-09) — the task LEDGER. An append-only JSONL event log at
// state/tasks/ledger.jsonl; current task state is FOLDED from the events (never
// mutated in place — same discipline as the loop trace store and the audit
// chain). Every mutation ALSO writes a hash-chained audit entry
// (task.created / task.completed / task.cancelled) referencing the task id, so
// the tamper-evident audit chain is the truth and the ledger is the queryable
// projection.
//
// v1 is a LEDGER, not an executor: no file or network side effects. The night
// cycle (Stage 8) proposes tasks here; it never auto-executes them.
//
// Server-only (node fs).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";

export type TaskStatus = "open" | "completed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  note: string | null;
  due: string | null; // ISO date string or null
  source: string | null; // e.g. "persona:bobby", "night-cycle", "email:<id>"
  /** Night cycle proposes tasks it has NOT executed — operator confirms later.
   *  Pure operator/persona-created tasks are not proposed. */
  proposed: boolean;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

type TaskEvent =
  | {
      op: "create";
      at: string;
      taskId: string;
      title: string;
      note: string | null;
      due: string | null;
      source: string | null;
      proposed: boolean;
    }
  | { op: "complete" | "cancel"; at: string; taskId: string; reason: string | null };

export function tasksStateDir(): string {
  return path.join(argosRoot(), "state", "tasks");
}
export function taskLedgerPath(): string {
  return path.join(tasksStateDir(), "ledger.jsonl");
}

async function appendEvent(ev: TaskEvent): Promise<void> {
  await fsp.mkdir(tasksStateDir(), { recursive: true });
  await fsp.appendFile(taskLedgerPath(), JSON.stringify(ev) + "\n", "utf8");
}

function readEvents(raw: string): TaskEvent[] {
  const out: TaskEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as TaskEvent;
      if (o && typeof o.taskId === "string" && typeof o.op === "string") out.push(o);
    } catch {
      /* skip malformed line — never lose the whole ledger to one bad line */
    }
  }
  return out;
}

/** Fold the ledger into the current task map (id → Task). */
async function foldLedger(): Promise<Map<string, Task>> {
  const tasks = new Map<string, Task>();
  let raw: string;
  try {
    raw = await fsp.readFile(taskLedgerPath(), "utf8");
  } catch {
    return tasks;
  }
  for (const ev of readEvents(raw)) {
    if (ev.op === "create") {
      tasks.set(ev.taskId, {
        id: ev.taskId,
        title: ev.title,
        note: ev.note,
        due: ev.due,
        source: ev.source,
        proposed: ev.proposed,
        status: "open",
        createdAt: ev.at,
        updatedAt: ev.at,
      });
    } else {
      const t = tasks.get(ev.taskId);
      if (!t) continue; // event for an unknown task — skip (never throw)
      // Terminal states are sticky: a completed/cancelled task ignores later ops.
      if (t.status !== "open") continue;
      t.status = ev.op === "complete" ? "completed" : "cancelled";
      t.updatedAt = ev.at;
    }
  }
  return tasks;
}

export interface CreateTaskInput {
  title: string;
  note?: string | null;
  due?: string | null;
  source?: string | null;
  proposed?: boolean;
  /** Stamp; passed in (callers own the clock — keeps the store testable). */
  at?: string;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const at = input.at ?? new Date().toISOString();
  const taskId = `t_${randomUUID().slice(0, 8)}`;
  const ev: TaskEvent = {
    op: "create",
    at,
    taskId,
    title: input.title.trim(),
    note: input.note?.trim() || null,
    due: input.due ?? null,
    source: input.source ?? null,
    proposed: input.proposed === true,
  };
  await appendEvent(ev);
  await appendAudit("task.created", {
    taskId,
    title: ev.title,
    due: ev.due,
    source: ev.source,
    proposed: ev.proposed,
  }).catch(() => {});
  return {
    id: taskId,
    title: ev.title,
    note: ev.note,
    due: ev.due,
    source: ev.source,
    proposed: ev.proposed,
    status: "open",
    createdAt: at,
    updatedAt: at,
  };
}

async function transition(
  taskId: string,
  op: "complete" | "cancel",
  reason: string | null,
  at: string
): Promise<{ ok: boolean; task?: Task; error?: string }> {
  const tasks = await foldLedger();
  const t = tasks.get(taskId);
  if (!t) return { ok: false, error: `unknown task: ${taskId}` };
  if (t.status !== "open") {
    return { ok: false, error: `task ${taskId} is already ${t.status}` };
  }
  await appendEvent({ op, at, taskId, reason });
  await appendAudit(op === "complete" ? "task.completed" : "task.cancelled", {
    taskId,
    title: t.title,
    reason,
  }).catch(() => {});
  return { ok: true, task: { ...t, status: op === "complete" ? "completed" : "cancelled", updatedAt: at } };
}

export function completeTask(taskId: string, reason?: string | null, at?: string) {
  return transition(taskId, "complete", reason?.trim() || null, at ?? new Date().toISOString());
}
export function cancelTask(taskId: string, reason?: string | null, at?: string) {
  return transition(taskId, "cancel", reason?.trim() || null, at ?? new Date().toISOString());
}

export interface ListTasksOptions {
  status?: TaskStatus | "all";
}

/** Current tasks, newest-created first. Default: open only. */
export async function listTasks(opts: ListTasksOptions = {}): Promise<Task[]> {
  const want = opts.status ?? "open";
  const all = [...(await foldLedger()).values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
  return want === "all" ? all : all.filter((t) => t.status === want);
}

export async function getTask(taskId: string): Promise<Task | null> {
  return (await foldLedger()).get(taskId) ?? null;
}

export interface TaskCounts {
  open: number;
  completed: number;
  cancelled: number;
  overdue: number;
}

/** Counts for the HUD / dashboard. `nowIso` lets callers control the clock. */
export async function taskCounts(nowIso?: string): Promise<TaskCounts> {
  const now = nowIso ?? new Date().toISOString();
  const all = [...(await foldLedger()).values()];
  const counts: TaskCounts = { open: 0, completed: 0, cancelled: 0, overdue: 0 };
  for (const t of all) {
    counts[t.status] += 1;
    if (t.status === "open" && t.due && t.due < now) counts.overdue += 1;
  }
  return counts;
}
