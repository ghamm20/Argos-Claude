// lib/tools/tasks.ts
//
// Stage 2 (2026-06-09) — the tasks tool. A LEDGER, not an executor: create /
// list / complete / cancel only. NO file or network side effects (writes land
// in state/tasks/ledger.jsonl + the hash-chained audit). Therefore UNGATED
// (no approval), but every mutation is audited through the store's appendAudit
// AND the executor's tool-audit entry.
//
// Call format (custom text format, parsed from the reply):
//   <tool>{"id":"tasks","params":{"operation":"create","title":"...","due":"2026-06-30","note":"..."}}</tool>
//   <tool>{"id":"tasks","params":{"operation":"list","status":"open"}}</tool>
//   <tool>{"id":"tasks","params":{"operation":"complete","taskId":"t_xxxxxxxx"}}</tool>
//   <tool>{"id":"tasks","params":{"operation":"cancel","taskId":"t_xxxxxxxx","reason":"..."}}</tool>

import { toolOk, toolErr, type ToolExecute, type ToolContext } from "./types";
import {
  createTask,
  listTasks,
  completeTask,
  cancelTask,
  type TaskStatus,
} from "../tasks/store";

export const ID = "tasks";

const OPS = new Set(["create", "list", "complete", "cancel"]);

function op(params: Record<string, unknown>): string {
  // Accept the `action` alias for consistency with file_ops.
  return String(params.operation ?? params.op ?? params.action ?? "").toLowerCase();
}

export function validate(params: Record<string, unknown>): { ok: boolean; error?: string } {
  const o = op(params);
  if (!OPS.has(o)) {
    return { ok: false, error: `unknown operation "${o}" (create|list|complete|cancel)` };
  }
  if (o === "create") {
    const title = String(params.title ?? "").trim();
    if (!title) return { ok: false, error: "create requires a title" };
  }
  if (o === "complete" || o === "cancel") {
    const taskId = String(params.taskId ?? params.id ?? "").trim();
    if (!taskId) return { ok: false, error: `${o} requires a taskId` };
  }
  return { ok: true };
}

export const execute: ToolExecute = async (params, ctx?: ToolContext) => {
  const o = op(params);
  const v = validate(params);
  if (!v.ok) return toolErr(ID, v.error ?? "invalid task operation");
  const source = ctx?.personaId ? `persona:${ctx.personaId}` : "operator";

  try {
    if (o === "create") {
      const t = await createTask({
        title: String(params.title),
        note: params.note != null ? String(params.note) : null,
        due: params.due != null ? String(params.due) : null,
        source,
        proposed: params.proposed === true,
      });
      return toolOk(ID, `created task ${t.id}: ${t.title}`, { data: { task: t } });
    }
    if (o === "list") {
      const status = (["open", "completed", "cancelled", "all"].includes(String(params.status))
        ? String(params.status)
        : "open") as TaskStatus | "all";
      const tasks = await listTasks({ status });
      const lines = tasks.map(
        (t) => `${t.id} [${t.status}]${t.due ? ` (due ${t.due})` : ""} ${t.title}`
      );
      return toolOk(ID, `${tasks.length} ${status} task(s)`, {
        data: { count: tasks.length, status, tasks, listing: lines.join("\n") },
      });
    }
    const taskId = String(params.taskId ?? params.id ?? "").trim();
    const reason = params.reason != null ? String(params.reason) : null;
    const r = o === "complete" ? await completeTask(taskId, reason) : await cancelTask(taskId, reason);
    if (!r.ok) return toolErr(ID, r.error ?? `${o} failed`);
    return toolOk(ID, `${o}d task ${taskId}`, { data: { task: r.task } });
  } catch (e) {
    return toolErr(ID, `${o} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
