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

import { evaluateResult, verdictToOutcome, type GamingContext } from "./eval-gate";
import { appendTrace, collectTraceRefs, readTraces } from "./trace-store";
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

/** A short signature of a loop result's output, for shortcut-pattern detection. */
function outputSignature(result: LoopResult): string {
  const d = (result.data ?? {}) as Record<string, unknown>;
  const candidate =
    (typeof d.output === "string" && d.output) ||
    (typeof d.refined === "string" && d.refined) ||
    (typeof d.suggestion === "string" && d.suggestion) ||
    (typeof d.lesson === "string" && d.lesson) ||
    (typeof d.insight === "string" && d.insight) ||
    result.summary ||
    "";
  return String(candidate).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Build the cross-run gaming context for a loop from its recent traces. */
async function buildGamingContext(
  def: LoopDefinition,
  result: LoopResult
): Promise<GamingContext> {
  let prior: LoopTrace[] = [];
  try {
    prior = await readTraces(def.id, 5);
  } catch {
    prior = [];
  }
  const d = (result.data ?? {}) as Record<string, unknown>;
  const specOf = (t: LoopTrace): string | null => {
    const td = (t.result.data ?? {}) as Record<string, unknown>;
    return typeof td.spec === "string" ? td.spec : typeof td.criteria === "string" ? td.criteria : null;
  };
  const recentOutputs = [...prior].reverse().map((t) => outputSignature(t.result));
  recentOutputs.push(outputSignature(result));
  return {
    priorScore: prior[0]?.evaluation?.score ?? null,
    priorSpec: prior[0] ? specOf(prior[0]) : null,
    currentSpec: typeof d.spec === "string" ? d.spec : typeof d.criteria === "string" ? d.criteria : null,
    recentOutputs,
    outputMatchesSpec:
      typeof d.outputMatchesSpec === "boolean" ? d.outputMatchesSpec : null,
  };
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
    context: await buildGamingContext(def, result),
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
