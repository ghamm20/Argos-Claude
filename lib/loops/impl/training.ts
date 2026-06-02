// lib/loops/impl/training.ts
//
// Training-adjacent loops: Self-Training (13), Benchmark (19).

import type { LoopDefinition, LoopContext } from "../loop";
import { loopFail, type LoopResult } from "../types";
import { readFacts } from "../../memory-extract";
import { readAllTraces, readTraces } from "../trace-store";
import { runBenchmark, benchmarkTaskIds } from "../benchmark";

function inputStr(ctx: LoopContext, key: string, fallback = ""): string {
  const v = ctx.input?.[key];
  return typeof v === "string" ? v : fallback;
}

// --- Loop13: Self-Training --------------------------------------------------
// HONEST SCOPE: ARGOS does not fine-tune models locally — there is no training
// infrastructure on this rig and no new dependencies are permitted. What this
// loop genuinely does is CURATE a fine-tune dataset from high-signal material
// (operator facts + accepted loop outputs) and propose it as a dataset for a
// FUTURE, off-rig fine-tune. It never claims to have trained anything.
export const selfTraining: LoopDefinition = {
  id: "self_training",
  loopNumber: 13,
  name: "Self-Training",
  description: "Curate a fine-tune dataset (does NOT fine-tune locally).",
  trigger: "manual",
  async run(_ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const facts = await readFacts();
      const accepted = (await readAllTraces(80)).filter((t) => t.outcome === "accepted");
      const examples: Array<{ instruction: string; input: string; output: string }> = [];

      // Pairs distilled from optimizer/refine loop outputs (real input→output).
      for (const t of accepted) {
        const d = t.result.data as Record<string, unknown> | null;
        if (!d) continue;
        if (t.loopId === "self_refine" && typeof d.original === "string" && typeof d.refined === "string") {
          examples.push({ instruction: "Improve this draft.", input: String(d.original).slice(0, 500), output: String(d.refined).slice(0, 800) });
        }
        if (t.loopId === "prompt_optimizer" && typeof d.base === "string" && typeof d.optimized === "string") {
          examples.push({ instruction: "Rewrite this instruction to be clearer.", input: String(d.base).slice(0, 300), output: String(d.optimized).slice(0, 500) });
        }
      }
      // Operator facts as Q/A-style recall examples.
      for (const f of facts.slice(0, 20)) {
        examples.push({ instruction: "State a known fact about the operator's context.", input: f.category, output: f.fact });
      }

      const jsonl = examples.map((e) => JSON.stringify(e)).join("\n");
      const note =
        "ARGOS does not fine-tune locally (no training infrastructure, no new deps). " +
        "This dataset is curated for a future off-rig fine-tune only.";
      return {
        loopId: "self_training",
        loopNumber: 13,
        ok: true,
        summary: `curated ${examples.length} training examples (no local fine-tune)`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals:
          examples.length > 0
            ? [
                {
                  kind: "dataset",
                  description: `Save ${examples.length} curated examples as a fine-tune dataset (operator decides; not used locally).`,
                  payload: jsonl,
                },
              ]
            : [],
        data: { exampleCount: examples.length, note, preview: examples.slice(0, 3) },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("self_training", 13, (e as Error).message, start);
    }
  },
};

// --- Loop19: Benchmark (GROUND TRUTH) ---------------------------------------
// Run the fixed, deterministically-graded benchmark and record the score. Sets
// benchmarkBefore from the previous benchmark trace so improvement is measured
// against ground truth. This loop is the anchor every other loop is checked
// against. It claims improvement ONLY when the score genuinely rose.
export const benchmark: LoopDefinition = {
  id: "benchmark",
  loopNumber: 19,
  name: "Benchmark Harness",
  description: "Ground-truth benchmark; the anti-gaming anchor for all loops.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const prior = await readTraces("benchmark", 1);
      const before =
        typeof prior[0]?.result?.benchmarkAfter === "number"
          ? (prior[0].result.benchmarkAfter as number)
          : null;
      const result = await runBenchmark({ model: inputStr(ctx, "model") || undefined });
      const after = result.score;
      const improved = before !== null && after > before;
      const failing = result.perTask.filter((t) => !t.passed).map((t) => t.id);
      const passing = result.perTask.filter((t) => t.passed).map((t) => t.id);
      // Evidence cites REAL benchmark task ids (in the gate's known-refs set).
      const evidenceRefs = (improved ? passing : failing).slice(0, 3);
      return {
        loopId: "benchmark",
        loopNumber: 19,
        ok: true,
        summary: `benchmark ${(after * 100).toFixed(0)}% (${result.passed}/${result.total})${
          before !== null ? `, prev ${(before * 100).toFixed(0)}%` : ""
        }`,
        claimedImprovement: improved, // honest: only when ground truth rose
        claimedScore: after,
        benchmarkBefore: before,
        benchmarkAfter: after,
        evidence: evidenceRefs.map((ref) => ({
          kind: "benchmark" as const,
          ref,
          before: before ?? undefined,
          after,
        })),
        proposals: [],
        data: { ...result, taskIds: benchmarkTaskIds() },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("benchmark", 19, (e as Error).message, start);
    }
  },
};
