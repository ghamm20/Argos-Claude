// lib/task-runner.ts
//
// Overnight Engine (2026-06-02) — executes one task end to end.
//
//   1. Bartimaeus breaks the goal into concrete tool steps (ultraplan).
//   2. Each step runs through the tool executor.
//      - dangerous tools are SKIPPED unless dangerous_tools_allowed (the flag
//        IS the operator's pre-authorization → executor runs them as approved).
//      - a failing step retries up to 3×, then is logged and SKIPPED — the task
//        never aborts as a whole.
//   3. Every step is logged to state/task-runner-<id>.log.
//   4. A result object is returned (the queue writes it to complete/).
//
// runTask NEVER throws and NEVER blocks the UI (the scheduler fires it in the
// background). A fatal planning failure is reported so the queue can move the
// task to failed/ with the error preserved.

import { promises as fsp } from "node:fs";
import { runTool } from "./tools/executor";
import { getTool, toolListForPrompt } from "./tools/registry";
import { callModel } from "./tools/util";
import { PERSONA_BY_ID } from "./personas";
import { pushoverSend } from "./research/alerts";
import { runnerLogPath, type TaskFile } from "./task-queue";
// Phase 3 (2026-06-10) — per-step hash-chained audit entries.
import { appendAudit } from "./audit";

const MAX_RETRIES = 3;
const PLAN_TIMEOUT_MS = 120_000;

async function appendLog(id: string, line: string): Promise<void> {
  try {
    const entry = `[${new Date().toISOString()}] ${line}` + "\n";
    await fsp.appendFile(runnerLogPath(id), entry, "utf8");
  } catch {
    /* logging is best-effort */
  }
}

interface PlanStep {
  tool_id: string;
  params: Record<string, unknown>;
  description: string;
}

function parseJsonArray(text: string): unknown[] {
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s < 0 || e < 0 || e < s) return [];
  try {
    const arr = JSON.parse(text.slice(s, e + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Sensible default params for the fallback plan when the model is unavailable. */
function deriveParams(toolId: string, goal: string): Record<string, unknown> {
  switch (toolId) {
    case "web_search":
    case "deep_research":
      return { query: goal };
    case "osint_lookup":
      return { subject: goal };
    case "doc_generate":
      return { title: goal.slice(0, 60), content: goal, format: "md" };
    case "threat_assess":
      return { situation: goal };
    default:
      return {};
  }
}

async function planSteps(task: TaskFile): Promise<PlanStep[]> {
  const model = PERSONA_BY_ID.bartimaeus.model;
  const system =
    "You are Bartimaeus, planning an overnight task for the operator. Break the goal into concrete steps using ONLY the available tools. Output ONLY a JSON array of {step, tool_id, params, description}. No prose, no markdown. Max 6 steps. Prefer safe tools.";
  const user = [
    `GOAL: ${task.goal}`,
    task.steps.length ? `Suggested tools: ${task.steps.join(", ")}` : "",
    "",
    "Available tools:",
    toolListForPrompt(),
    "",
    "Return the JSON plan.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const out = await callModel(model, system, user, { timeoutMs: PLAN_TIMEOUT_MS });
    const arr = parseJsonArray(out);
    const steps: PlanStep[] = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const toolId = typeof o.tool_id === "string" ? o.tool_id : "";
      if (!getTool(toolId)) continue;
      steps.push({
        tool_id: toolId,
        params: o.params && typeof o.params === "object" ? (o.params as Record<string, unknown>) : {},
        description: typeof o.description === "string" ? o.description : "",
      });
      if (steps.length >= 6) break;
    }
    if (steps.length > 0) return steps;
  } catch {
    /* planning failed — fall through to the deterministic fallback */
  }

  // Fallback: the suggested tools, else a single web search on the goal.
  const fallback = task.steps
    .filter((id) => getTool(id))
    .map((id) => ({ tool_id: id, params: deriveParams(id, task.goal), description: `(fallback) ${id}` }));
  if (fallback.length > 0) return fallback.slice(0, 6);
  return [{ tool_id: "web_search", params: { query: task.goal }, description: "(fallback) search the goal" }];
}

export interface StepResult {
  step: number;
  tool_id: string;
  description: string;
  ok: boolean;
  skipped: boolean;
  attempts: number;
  summary: string;
  data: unknown;
  error: string | null;
}

export interface TaskResult {
  taskId: string;
  goal: string;
  completedAt: string;
  summary: string;
  stepsPlanned: number;
  stepsOk: number;
  steps: StepResult[];
  dangerousAllowed: boolean;
}

/** Run a task to completion. Never throws. Returns { failed:false, result } on
 *  a normal run (even with failed steps), or { failed:true, error } only on a
 *  fatal/unexpected error so the queue can archive it under failed/. */
export async function runTask(
  task: TaskFile
): Promise<{ failed: boolean; result?: TaskResult; error?: string }> {
  try {
    await appendLog(
      task.id,
      `START goal="${task.goal}" priority=${task.priority} dangerousAllowed=${task.dangerous_tools_allowed}`
    );
    const ctx = {
      sessionId: null,
      personaId: "bartimaeus",
      model: PERSONA_BY_ID.bartimaeus.model,
    };
    const plan = await planSteps(task);
    await appendLog(task.id, `PLAN ${plan.length} step(s): ${plan.map((p) => p.tool_id).join(", ")}`);

    const steps: StepResult[] = [];
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const tool = getTool(step.tool_id);
      const n = i + 1;
      if (!tool) {
        await appendLog(task.id, `SKIP step ${n} ${step.tool_id} — unknown tool`);
        await appendAudit("task.step", { taskId: task.id, step: n, toolId: step.tool_id, ok: false, skipped: true, reason: "unknown tool" }).catch(() => {});
        steps.push(stepSkip(n, step, "unknown tool"));
        continue;
      }
      if (tool.dangerous && !task.dangerous_tools_allowed) {
        await appendLog(task.id, `SKIP step ${n} ${step.tool_id} — dangerous tool, not allowed for this task`);
        await appendAudit("task.step", { taskId: task.id, step: n, toolId: step.tool_id, ok: false, skipped: true, reason: "dangerous tool not allowed" }).catch(() => {});
        steps.push(stepSkip(n, step, "dangerous tool not allowed"));
        continue;
      }

      let result: { ok: boolean; summary: string; data?: unknown; error?: string } | null = null;
      let attempts = 0;
      let ok = false;
      for (attempts = 1; attempts <= MAX_RETRIES; attempts++) {
        try {
          // The flag pre-authorizes dangerous tools → run as approved.
          const approved = tool.dangerous ? true : null;
          result = await runTool(step.tool_id, step.params, ctx, approved);
          if (result.ok) {
            ok = true;
            break;
          }
          await appendLog(task.id, `step ${n} ${step.tool_id} attempt ${attempts} failed: ${result.error ?? result.summary}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await appendLog(task.id, `step ${n} ${step.tool_id} attempt ${attempts} threw: ${msg}`);
          result = { ok: false, summary: "threw", error: msg };
        }
      }
      await appendLog(
        task.id,
        `step ${n} ${step.tool_id} ${ok ? "OK" : `FAILED after ${MAX_RETRIES} retries`}: ${result?.summary ?? ""}`
      );
      // Phase 3 — every step lands in the hash-chained audit log (gate 3).
      await appendAudit("task.step", {
        taskId: task.id,
        step: n,
        toolId: step.tool_id,
        ok,
        attempts: ok ? attempts : MAX_RETRIES,
        summary: (result?.summary ?? "").slice(0, 300),
        error: ok ? null : (result?.error ?? "failed after retries").slice(0, 300),
      }).catch(() => {});
      steps.push({
        step: n,
        tool_id: step.tool_id,
        description: step.description,
        ok,
        skipped: false,
        attempts: ok ? attempts : MAX_RETRIES,
        summary: result?.summary ?? "",
        data: ok ? result?.data ?? null : null,
        error: ok ? null : result?.error ?? "failed after retries",
      });
    }

    const stepsOk = steps.filter((s) => s.ok).length;
    const summary = `${stepsOk}/${plan.length} step(s) succeeded`;
    await appendLog(task.id, `DONE ${summary}`);
    const result: TaskResult = {
      taskId: task.id,
      goal: task.goal,
      completedAt: new Date().toISOString(),
      summary,
      stepsPlanned: plan.length,
      stepsOk,
      steps,
      dangerousAllowed: task.dangerous_tools_allowed,
    };
    return { failed: false, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await appendLog(task.id, `FATAL ${msg}`);
    return { failed: true, error: msg };
  }
}

function stepSkip(n: number, step: PlanStep, reason: string): StepResult {
  return {
    step: n,
    tool_id: step.tool_id,
    description: step.description,
    ok: false,
    skipped: true,
    attempts: 0,
    summary: `skipped: ${reason}`,
    data: null,
    error: null,
  };
}

/** Per-task Pushover notification, honoring notify_on. Fire-and-forget. */
export async function notifyTaskResult(
  task: TaskFile,
  status: "complete" | "failed",
  summary: string
): Promise<void> {
  const want =
    task.notify_on === "both" ||
    (status === "complete" && task.notify_on === "complete") ||
    (status === "failed" && task.notify_on === "error");
  if (!want) return;
  try {
    await pushoverSend({
      title: status === "complete" ? `✓ Task complete — ${task.goal.slice(0, 48)}` : `✗ Task failed — ${task.goal.slice(0, 48)}`,
      message: summary.slice(0, 900),
      priority: status === "failed" ? "1" : "0",
    });
  } catch {
    /* notification is best-effort */
  }
}
