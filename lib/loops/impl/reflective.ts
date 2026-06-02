// lib/loops/impl/reflective.ts
//
// Reflective loops: Reflexion (7), Self-Refine (8), Trace Analysis (4),
// Meta-Optimizer (20). These produce insight/artifacts; none claim a
// benchmark improvement, so the eval gate accepts a clean run.

import type { LoopDefinition, LoopContext } from "../loop";
import { personaModel, loopModelCall } from "../loop";
import { loopFail, type LoopResult } from "../types";
import { readAllTraces, traceStats, readTraces } from "../trace-store";

function inputStr(ctx: LoopContext, key: string, fallback = ""): string {
  const v = ctx.input?.[key];
  return typeof v === "string" ? v : fallback;
}

// --- Loop7: Reflexion -------------------------------------------------------
// Reflect on a failure / hard exchange and distill a reusable lesson. Proposes
// storing the lesson to memory (low-risk). Does NOT claim a measured gain.
export const reflexion: LoopDefinition = {
  id: "reflexion",
  loopNumber: 7,
  name: "Reflexion",
  description: "Reflect on a failure and distill a reusable lesson.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const failure =
        inputStr(ctx, "failure") ||
        inputStr(ctx, "context") ||
        "A recent attempt did not achieve its goal. Reflect generally on common failure modes.";
      const model = personaModel("bartimaeus");
      const lesson = await loopModelCall(
        model,
        "You are Bartimaeus running a Reflexion loop. Given a failure, produce ONE concise, actionable lesson (1-2 sentences) that would prevent it next time. No preamble.",
        `FAILURE/CONTEXT:\n${failure}\n\nThe lesson:`,
        { numPredict: 200, temperature: 0.3 }
      );
      const clean = lesson.trim();
      return {
        loopId: "reflexion",
        loopNumber: 7,
        ok: clean.length > 0,
        summary: clean ? `lesson: ${clean.slice(0, 120)}` : "no lesson produced",
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: clean
          ? [
              {
                kind: "memory",
                description: "Store the reflexion lesson for future recall.",
                payload: clean,
              },
            ]
          : [],
        data: { lesson: clean, source: failure.slice(0, 400) },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("reflexion", 7, (e as Error).message, start);
    }
  },
};

// --- Loop8: Self-Refine (/refine) -------------------------------------------
// Critique then rewrite a draft, up to N iterations. Returns the refined text.
// Informational (no proposals): the refined output IS the deliverable.
export const selfRefine: LoopDefinition = {
  id: "self_refine",
  loopNumber: 8,
  name: "Self-Refine",
  description: "Iteratively critique and improve a draft (/refine).",
  trigger: "command",
  command: "refine",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const draft = inputStr(ctx, "text") || inputStr(ctx, "draft");
      if (!draft) return loopFail("self_refine", 8, "no text/draft provided", start);
      const iterations = Math.max(1, Math.min(3, Number(ctx.input?.iterations ?? 1) || 1));
      const model = personaModel("sage");
      let current = draft;
      const history: Array<{ critique: string; revised: string }> = [];
      for (let i = 0; i < iterations; i++) {
        const out = await loopModelCall(
          model,
          "You are running a Self-Refine loop. (1) Briefly critique the draft's weaknesses. (2) Then output the improved version. Format EXACTLY as:\nCRITIQUE: <one or two sentences>\nREVISED:\n<the full improved text>",
          `DRAFT:\n${current}`,
          { numPredict: 700, temperature: 0.4 }
        );
        const cm = out.match(/CRITIQUE:\s*([\s\S]*?)\nREVISED:\s*([\s\S]*)$/i);
        const critique = cm ? cm[1].trim() : "(no explicit critique)";
        const revised = cm ? cm[2].trim() : out.trim();
        if (revised) {
          history.push({ critique, revised });
          current = revised;
        }
      }
      const changed = current.trim() !== draft.trim();
      return {
        loopId: "self_refine",
        loopNumber: 8,
        ok: true,
        summary: `refined over ${history.length} iteration(s)${changed ? "" : " (no change)"}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { original: draft, refined: current, iterations: history },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("self_refine", 8, (e as Error).message, start);
    }
  },
};

// --- Loop4: Trace Analysis (nightly 2AM) ------------------------------------
// Mine the append-only trace store for patterns (halts, rejects, which loops
// improve) and surface the top issue. Informational.
export const traceAnalysis: LoopDefinition = {
  id: "trace_analysis",
  loopNumber: 4,
  name: "Trace Analysis",
  description: "Mine loop traces nightly for patterns and the top issue.",
  trigger: "scheduled",
  schedule: { dayOfWeek: "daily", hour: 2, minute: 0, label: "nightly 2AM" },
  async run(_ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const stats = await traceStats();
      const recent = await readAllTraces(40);
      let insight = "Not enough trace history to analyze yet.";
      if (recent.length > 0) {
        const digest = recent
          .map(
            (t) =>
              `${t.loopId} → ${t.outcome} (score ${t.evaluation.score.toFixed(2)}${
                t.evaluation.gamingDetected ? ", GAMED" : ""
              })`
          )
          .join("\n");
        insight = await loopModelCall(
          personaModel("bartimaeus"),
          "You are analyzing self-improvement loop traces. Identify the single most important pattern or problem in this digest and state it in 1-2 sentences. Be specific. No preamble.",
          `TRACE DIGEST (most recent first):\n${digest.slice(0, 3000)}`,
          { numPredict: 220, temperature: 0.3 }
        ).catch(() => insight);
      }
      return {
        loopId: "trace_analysis",
        loopNumber: 4,
        ok: true,
        summary: `${stats.totalTraces} trace(s); halted ${stats.halted}, pending ${stats.pendingApproval}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { stats, insight: insight.trim(), analyzed: recent.length },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("trace_analysis", 4, (e as Error).message, start);
    }
  },
};

// --- Loop20: Meta-Optimizer -------------------------------------------------
// The capstone. Reads trace stats + the latest benchmark and recommends which
// loops to prioritize next. Informational — it schedules thinking, not change.
export const metaOptimizer: LoopDefinition = {
  id: "meta_optimizer",
  loopNumber: 20,
  name: "Meta-Optimizer",
  description: "Decide which loops to prioritize next, from traces + benchmark.",
  trigger: "manual",
  async run(_ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const stats = await traceStats();
      const benchTraces = await readTraces("benchmark", 1);
      const latestBench =
        benchTraces[0]?.result?.benchmarkAfter ??
        benchTraces[0]?.evaluation?.score ??
        null;
      const ranking = await loopModelCall(
        personaModel("bartimaeus"),
        "You are the meta-optimizer for a self-improving system. Given current stats, recommend the top 3 loops to run next and why, in 3 short bullet points. No preamble.",
        `STATS: ${JSON.stringify(stats)}\nLATEST BENCHMARK: ${
          latestBench === null ? "none yet" : latestBench.toFixed(3)
        }`,
        { numPredict: 280, temperature: 0.4 }
      ).catch(() => "");
      return {
        loopId: "meta_optimizer",
        loopNumber: 20,
        ok: true,
        summary: `meta plan from ${stats.totalTraces} traces, benchmark ${
          latestBench === null ? "n/a" : latestBench.toFixed(2)
        }`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { stats, latestBenchmark: latestBench, plan: ranking.trim() },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("meta_optimizer", 20, (e as Error).message, start);
    }
  },
};
