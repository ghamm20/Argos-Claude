// lib/loops/orchestrator.ts
//
// Self-Evolving Loop Suite (2026-06-02) — runLoop: the one path every loop run
// takes. It runs the loop, evaluates the result through the eval gate (with
// the REAL known-refs set so fabricated evidence is caught), records an
// append-only trace, and — if the gate halts the run — alerts the operator.
//
// Nothing is ever applied here. Acceptance of a high-risk proposal only marks
// the trace "awaiting_approval"; actual application happens in the governed
// /api/loops/approve-patch route (restore point + boundary + governance gate).

import { evaluateResult, verdictToOutcome } from "./eval-gate";
import { appendTrace, collectTraceRefs } from "./trace-store";
import { benchmarkTaskIds } from "./benchmark";
import { loopFail } from "./types";
import { pushoverSend } from "../research/alerts";
import { getLoop } from "./registry";
import type { LoopDefinition, LoopContext } from "./loop";
import type { LoopResult, EvalResult, LoopTrace, LoopTrigger } from "./types";

export interface LoopRun {
  result: LoopResult;
  evaluation: EvalResult;
  traceId: string;
  outcome: LoopTrace["outcome"];
}

/** Build the set of references the eval gate treats as REAL: every benchmark
 *  task id plus every existing trace id. Evidence citing anything else is
 *  fabricated. */
async function knownRefs(): Promise<Set<string>> {
  const refs = new Set<string>(benchmarkTaskIds());
  try {
    for (const r of await collectTraceRefs()) refs.add(r);
  } catch {
    /* trace store unreadable → just use benchmark ids */
  }
  return refs;
}

export async function runLoop(
  def: LoopDefinition,
  ctx: LoopContext
): Promise<LoopRun> {
  const start = Date.now();
  let result: LoopResult;
  try {
    result = await def.run(ctx);
  } catch (e) {
    result = loopFail(
      def.id,
      def.loopNumber,
      e instanceof Error ? e.message : String(e),
      start
    );
  }

  const evaluation: EvalResult = evaluateResult(result, {
    knownRefs: await knownRefs(),
  });

  // Map verdict → outcome; a fatal loop error is recorded as "error" (more
  // precise than the verdict's "rejected").
  let outcome: LoopTrace["outcome"] = verdictToOutcome(evaluation.verdict);
  if (!result.ok) outcome = "error";

  // Gate halt (gaming / hard violation) → alert the operator. Best-effort.
  if (evaluation.verdict === "halt") {
    void pushoverSend({
      title: `⛔ ARGOS loop HALTED — ${def.name}`,
      message:
        `Loop ${def.loopNumber} (${def.id}) was halted by the eval gate.\n` +
        `Reasons: ${evaluation.gamingReasons.join("; ").slice(0, 800)}`,
      priority: "1",
    }).catch(() => {});
  }

  const trace: LoopTrace = {
    at: new Date().toISOString(),
    loopId: def.id,
    loopNumber: def.loopNumber,
    trigger: ctx.trigger,
    result,
    evaluation,
    outcome,
    sessionId: ctx.sessionId,
  };
  const traceId = await appendTrace(trace);

  return { result, evaluation, traceId, outcome };
}

/** Run a loop by id with optional input. Returns null if the id is unknown.
 *  Used by the API routes (/evolve, /debate, /simulate, /benchmark, …). */
export async function runLoopById(
  id: string,
  input: Record<string, unknown> = {},
  opts: { trigger?: LoopTrigger; sessionId?: string | null } = {}
): Promise<LoopRun | null> {
  const def = getLoop(id);
  if (!def) return null;
  return runLoop(def, {
    trigger: opts.trigger ?? "manual",
    sessionId: opts.sessionId ?? null,
    input,
  });
}
