// lib/workflow/engine.ts
//
// Phase 5 (2026-06-10) — THE WORKFLOW ENGINE. Chained multi-step workflows:
// the output of one governed tool feeds the next, and PER-STEP GATES ARE
// PRESERVED — a chain CANNOT launder a delete (or any approval-required op)
// past the approval queue. That is the load-bearing property of this module:
//
//   - Before EVERY step the engine evaluates the tool's own governance
//     (resolveGov(tool.requiresApproval, params)) on the step's RESOLVED
//     params. Approval required → the workflow HALTS mid-chain
//     (status "halted_approval", durably persisted). The engine never
//     passes approved=true on its own — the ONLY call site that does is
//     the operator-approve branch of decideWorkflow().
//   - Workflow approvals are DURABLE (workflow state file), not the 60s
//     in-memory tool-approval store: a halted chain waits for the operator
//     indefinitely, surviving restarts.
//
// DURABILITY: state/workflows/<id>.json holds the full workflow (steps,
// per-step results, cursor, status). A process restart loses nothing:
// "halted_approval"/"completed"/"aborted"/"failed" states simply persist;
// a workflow caught mid-run ("running" on disk at boot) is resumed from its
// cursor by resumeInterruptedWorkflows() (the step that was in flight
// re-runs; completed steps never re-run).
//
// OUTPUT PIPING: step params may reference earlier results with string
// values "$prev.<path>" or "$steps[N].<path>" (dot-path into the prior
// ToolResult, e.g. "$prev.data.results" or "$steps[0].summary"). Resolution
// happens just before governance evaluation so gates see the REAL params.
//
// Audit: workflow.created / workflow.step / workflow.halted /
// workflow.resumed / workflow.completed / workflow.aborted — all on the
// hash chain.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";
import { runTool } from "../tools/executor";
import { getTool } from "../tools/registry";
import { resolveGov, type ToolResult } from "../tools/types";
import { PERSONA_BY_ID } from "../personas";

export interface WorkflowStepSpec {
  toolId: string;
  params: Record<string, unknown>;
  description: string;
}

export type WorkflowStatus =
  | "running"
  | "halted_approval"
  | "completed"
  | "aborted"
  | "failed";

export interface WorkflowState {
  id: string;
  title: string;
  at: string;
  steps: WorkflowStepSpec[];
  /** One slot per step; null until the step has run. */
  results: Array<ToolResult | null>;
  /** Index of the next step to run (or the halted step). */
  cursor: number;
  status: WorkflowStatus;
  /** Set while halted: the resolved params + governance reason shown to the
   *  operator (what WILL run on approval — no surprises). */
  halted: { toolId: string; resolvedParams: Record<string, unknown>; reason: string } | null;
  updatedAt: string;
  error: string | null;
}

export function workflowsDir(): string {
  return path.join(argosRoot(), "state", "workflows");
}
function wfPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]+/g, "");
  return path.join(workflowsDir(), `${safe}.json`);
}

async function persist(w: WorkflowState): Promise<void> {
  await fsp.mkdir(workflowsDir(), { recursive: true });
  w.updatedAt = new Date().toISOString();
  const tmp = `${wfPath(w.id)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(w, null, 2), "utf8");
  await fsp.rename(tmp, wfPath(w.id));
}

export async function readWorkflow(id: string): Promise<WorkflowState | null> {
  try {
    return JSON.parse(await fsp.readFile(wfPath(id), "utf8")) as WorkflowState;
  } catch {
    return null;
  }
}

export async function listWorkflows(): Promise<WorkflowState[]> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(workflowsDir())).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: WorkflowState[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(workflowsDir(), n), "utf8")) as WorkflowState);
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

// ---- $prev / $steps[N] piping ----

function dig(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function resolveParams(
  params: Record<string, unknown>,
  results: Array<ToolResult | null>,
  cursor: number
): Record<string, unknown> {
  const resolveValue = (v: unknown): unknown => {
    if (typeof v !== "string") {
      if (Array.isArray(v)) return v.map(resolveValue);
      if (v && typeof v === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, vv] of Object.entries(v as Record<string, unknown>)) o[k] = resolveValue(vv);
        return o;
      }
      return v;
    }
    const prev = v.match(/^\$prev(?:\.(.+))?$/);
    if (prev) {
      const r = results[cursor - 1] ?? null;
      const got = prev[1] ? dig(r, prev[1]) : r;
      return typeof got === "string" ? got : got === undefined ? "" : JSON.stringify(got);
    }
    const idx = v.match(/^\$steps\[(\d+)\](?:\.(.+))?$/);
    if (idx) {
      const r = results[parseInt(idx[1], 10)] ?? null;
      const got = idx[2] ? dig(r, idx[2]) : r;
      return typeof got === "string" ? got : got === undefined ? "" : JSON.stringify(got);
    }
    return v;
  };
  return resolveValue(params) as Record<string, unknown>;
}

// ---- lifecycle ----

const ctx = () => ({ sessionId: null, personaId: "bartimaeus", model: PERSONA_BY_ID.bartimaeus.model });

export async function createWorkflow(title: string, steps: WorkflowStepSpec[]): Promise<WorkflowState> {
  const w: WorkflowState = {
    id: `wf_${randomUUID().slice(0, 8)}`,
    title: title.slice(0, 160),
    at: new Date().toISOString(),
    steps,
    results: steps.map(() => null),
    cursor: 0,
    status: "running",
    halted: null,
    updatedAt: new Date().toISOString(),
    error: null,
  };
  await persist(w);
  await appendAudit("workflow.created", { workflowId: w.id, title: w.title, steps: steps.map((s) => s.toolId) }).catch(() => {});
  return w;
}

/** Advance the workflow from its cursor until completion, a HALT, or a
 *  failure. NEVER passes approved=true — see decideWorkflow for the only
 *  operator-approval execution path. */
export async function advanceWorkflow(w: WorkflowState): Promise<WorkflowState> {
  while (w.cursor < w.steps.length) {
    const step = w.steps[w.cursor];
    const tool = getTool(step.toolId);
    if (!tool) {
      w.status = "failed";
      w.error = `unknown tool at step ${w.cursor + 1}: ${step.toolId}`;
      await persist(w);
      await appendAudit("workflow.step", { workflowId: w.id, step: w.cursor + 1, toolId: step.toolId, ok: false, error: w.error }).catch(() => {});
      return w;
    }
    const resolved = resolveParams(step.params, w.results, w.cursor);

    // ---- THE GATE: per-step governance on RESOLVED params ----
    if (resolveGov(tool.requiresApproval, resolved)) {
      w.status = "halted_approval";
      w.halted = {
        toolId: step.toolId,
        resolvedParams: resolved,
        reason: `step ${w.cursor + 1}/${w.steps.length} (${step.toolId}) requires operator approval — chain halted, nothing after it has run`,
      };
      await persist(w);
      await appendAudit("workflow.halted", { workflowId: w.id, step: w.cursor + 1, toolId: step.toolId, reason: "approval_required" }).catch(() => {});
      return w;
    }

    const result = await runTool(step.toolId, resolved, ctx(), /* approved: not required */ null);
    w.results[w.cursor] = result;
    await appendAudit("workflow.step", { workflowId: w.id, step: w.cursor + 1, toolId: step.toolId, ok: result.ok, summary: result.summary?.slice(0, 200) ?? null }).catch(() => {});
    if (!result.ok) {
      w.status = "failed";
      w.error = `step ${w.cursor + 1} (${step.toolId}) failed: ${result.error ?? result.summary}`;
      await persist(w);
      return w;
    }
    w.cursor += 1;
    await persist(w);
  }
  w.status = "completed";
  w.halted = null;
  await persist(w);
  await appendAudit("workflow.completed", { workflowId: w.id, title: w.title, steps: w.steps.length }).catch(() => {});
  return w;
}

/** Operator decision on a HALTED workflow. Approve → the halted step runs
 *  (the ONLY approved=true call site in this engine) and the chain
 *  continues — possibly halting again at a later gated step. Reject →
 *  clean abort: remaining steps never run. */
export async function decideWorkflow(
  id: string,
  decision: "approve" | "reject"
): Promise<{ ok: boolean; workflow?: WorkflowState; error?: string }> {
  const w = await readWorkflow(id);
  if (!w) return { ok: false, error: "unknown workflow" };
  if (w.status !== "halted_approval" || !w.halted) {
    return { ok: false, error: `workflow is ${w.status}, not awaiting approval` };
  }

  if (decision === "reject") {
    w.status = "aborted";
    w.error = `operator rejected step ${w.cursor + 1} (${w.halted.toolId}); remaining steps not run`;
    w.halted = null;
    await persist(w);
    await appendAudit("workflow.aborted", { workflowId: w.id, atStep: w.cursor + 1 }).catch(() => {});
    return { ok: true, workflow: w };
  }

  const step = w.steps[w.cursor];
  const resolved = w.halted.resolvedParams;
  const result = await runTool(step.toolId, resolved, ctx(), /* operator approved */ true);
  w.results[w.cursor] = result;
  await appendAudit("workflow.step", { workflowId: w.id, step: w.cursor + 1, toolId: step.toolId, ok: result.ok, approvedByOperator: true, summary: result.summary?.slice(0, 200) ?? null }).catch(() => {});
  if (!result.ok) {
    w.status = "failed";
    w.error = `approved step ${w.cursor + 1} failed: ${result.error ?? result.summary}`;
    w.halted = null;
    await persist(w);
    return { ok: true, workflow: w };
  }
  w.cursor += 1;
  w.status = "running";
  w.halted = null;
  await persist(w);
  const advanced = await advanceWorkflow(w);
  return { ok: true, workflow: advanced };
}

/** Boot-time recovery: any workflow persisted as "running" was interrupted
 *  by a process exit mid-run — resume it from its cursor (completed steps
 *  never re-run; the in-flight step re-runs). Halted/terminal workflows are
 *  left exactly as persisted. */
export async function resumeInterruptedWorkflows(): Promise<number> {
  const all = await listWorkflows();
  let resumed = 0;
  for (const w of all) {
    if (w.status !== "running") continue;
    resumed += 1;
    await appendAudit("workflow.resumed", { workflowId: w.id, atStep: w.cursor + 1, reason: "process_restart" }).catch(() => {});
    // Sequential on purpose: one resumed chain at a time, same as live runs.
    await advanceWorkflow(w);
  }
  return resumed;
}
