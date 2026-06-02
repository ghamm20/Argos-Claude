// lib/loops/impl/optimize.ts
//
// Optimization loops: Prompt Optimizer (6), Evolutionary (5),
// Reward Optimization (14), Curriculum (17).

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { LoopDefinition, LoopContext } from "../loop";
import { personaModel, loopModelCall } from "../loop";
import { loopFail, type LoopResult } from "../types";
import { readAllTraces, readTraces } from "../trace-store";
import { argosRoot } from "../../vault/paths";
import { pushoverSend } from "../../research/alerts";

function inputStr(ctx: LoopContext, key: string, fallback = ""): string {
  const v = ctx.input?.[key];
  return typeof v === "string" ? v : fallback;
}

// --- Loop6: Prompt Optimizer (DSPy-style) -----------------------------------
// Improve a base instruction with a meta-prompt. Low-risk prompt proposal.
export const promptOptimizer: LoopDefinition = {
  id: "prompt_optimizer",
  loopNumber: 6,
  name: "Prompt Optimizer",
  description: "DSPy-style: rewrite a base instruction to be clearer + tighter.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const base =
        inputStr(ctx, "prompt") ||
        "Answer the operator's question accurately and concisely.";
      const optimized = await loopModelCall(
        personaModel("bartimaeus"),
        "You optimize instructions (DSPy-style). Rewrite the given instruction to be clearer, more specific, and harder to misinterpret, WITHOUT changing its intent. Output ONLY the rewritten instruction.",
        `INSTRUCTION:\n${base}`,
        { numPredict: 300, temperature: 0.3 }
      );
      const changed = optimized.trim() && optimized.trim() !== base.trim();
      return {
        loopId: "prompt_optimizer",
        loopNumber: 6,
        ok: true,
        summary: changed ? "produced an optimized instruction" : "no change",
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [
          { kind: "comparison", ref: "prompt-opt", note: "base vs optimized (model-judged)" },
        ],
        proposals: changed
          ? [
              {
                kind: "prompt",
                description: "Adopt the optimized instruction (operator applies).",
                payload: optimized.trim(),
              },
            ]
          : [],
        data: { base, optimized: optimized.trim() },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("prompt_optimizer", 6, (e as Error).message, start);
    }
  },
};

// --- Loop5: Evolutionary ----------------------------------------------------
// Generate a small population of variants of a seed instruction, judge fitness
// with the model, keep the fittest. Fitness is MODEL-JUDGED (not ground truth);
// the result is honestly labelled as such. Low-risk prompt proposal.
export const evolutionary: LoopDefinition = {
  id: "evolutionary",
  loopNumber: 5,
  name: "Evolutionary",
  description: "Evolve instruction variants by model-judged fitness.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const seed =
        inputStr(ctx, "seed") ||
        inputStr(ctx, "prompt") ||
        "Be precise and answer the actual question.";
      const popSize = Math.max(2, Math.min(4, Number(ctx.input?.population ?? 3) || 3));
      const model = personaModel("bartimaeus");
      const variants: string[] = [seed];
      for (let i = 1; i < popSize; i++) {
        const v = await loopModelCall(
          model,
          "You mutate an instruction into a meaningfully different but valid variant (same intent, new wording/emphasis). Output ONLY the variant.",
          `INSTRUCTION:\n${seed}\nVariant ${i}:`,
          { numPredict: 160, temperature: 0.8 }
        ).catch(() => "");
        if (v.trim()) variants.push(v.trim());
      }
      // Judge fitness: ask the model to pick the best variant by index.
      const numbered = variants.map((v, i) => `[${i}] ${v}`).join("\n");
      const pick = await loopModelCall(
        model,
        "You are a fitness judge. Choose the SINGLE best instruction variant for clarity + effectiveness. Reply with only its number in brackets, e.g. [2].",
        numbered,
        { numPredict: 16, temperature: 0 }
      ).catch(() => "[0]");
      const m = pick.match(/\[(\d+)\]/);
      const idx = m ? Math.min(variants.length - 1, Math.max(0, Number(m[1]))) : 0;
      const fittest = variants[idx];
      return {
        loopId: "evolutionary",
        loopNumber: 5,
        ok: true,
        summary: `evolved ${variants.length} variants; fittest = [${idx}]`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [
          { kind: "comparison", ref: "evolution", note: `model-judged fittest among ${variants.length}` },
        ],
        proposals:
          idx !== 0
            ? [
                {
                  kind: "prompt",
                  description: "Adopt the evolved fittest instruction (operator applies).",
                  payload: fittest,
                },
              ]
            : [],
        data: { seed, variants, fittestIndex: idx, fittest },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("evolutionary", 5, (e as Error).message, start);
    }
  },
};

// --- Loop14: Reward Optimization --------------------------------------------
// Analyze recent eval outcomes and SUGGEST a reward-threshold adjustment. This
// is a config-class proposal (high-risk) with NO governance file target — it
// is advisory and routes to operator approval. Never edits the gate itself.
export const rewardOptimization: LoopDefinition = {
  id: "reward_optimization",
  loopNumber: 14,
  name: "Reward Optimization",
  description: "Suggest reward/threshold tuning from recent eval outcomes.",
  trigger: "manual",
  async run(_ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const recent = await readAllTraces(60);
      const counts = { accepted: 0, rejected: 0, halted: 0, awaiting: 0, error: 0 };
      for (const t of recent) {
        if (t.outcome === "accepted") counts.accepted++;
        else if (t.outcome === "rejected") counts.rejected++;
        else if (t.outcome === "halted") counts.halted++;
        else if (t.outcome === "awaiting_approval") counts.awaiting++;
        else if (t.outcome === "error") counts.error++;
      }
      const total = recent.length || 1;
      const rejectRate = counts.rejected / total;
      // Heuristic suggestion (advisory only — operator decides).
      let suggestion: string;
      if (rejectRate > 0.6)
        suggestion = "Reject rate is high — consider loosening the approval delta or accepting more low-risk proposals.";
      else if (counts.halted > counts.accepted)
        suggestion = "More halts than accepts — verify loops are providing real evidence; gate is doing its job.";
      else suggestion = "Reward thresholds look balanced; no change recommended.";
      const recommend = !suggestion.startsWith("Reward thresholds look balanced");
      return {
        loopId: "reward_optimization",
        loopNumber: 14,
        ok: true,
        summary: `reject ${(rejectRate * 100).toFixed(0)}% over ${recent.length} traces — ${recommend ? "tuning suggested" : "balanced"}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [{ kind: "metric", ref: "outcome-distribution", note: JSON.stringify(counts) }],
        proposals: recommend
          ? [
              {
                kind: "config",
                description: `Advisory reward-threshold tuning: ${suggestion}`,
                payload: JSON.stringify({ counts, rejectRate, suggestion }),
              },
            ]
          : [],
        data: { counts, rejectRate, suggestion },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("reward_optimization", 14, (e as Error).message, start);
    }
  },
};

// --- Loop17: Curriculum -----------------------------------------------------
// Per-topic mastery tracking from the latest benchmark byCategory. Mastery >0.85
// advances the topic to a harder level; <0.3 for 5 attempts marks it "stuck" and
// pages the operator to break it down. State: data/curriculum/<topic>-progress.json.
interface TopicProgress {
  attempts: number;
  mastery: number;
  level: number;
  lowStreak: number;
  status: "learning" | "advanced" | "struggling";
}
export const curriculum: LoopDefinition = {
  id: "curriculum",
  loopNumber: 17,
  name: "Curriculum",
  description: "Per-topic mastery tracking; advance on >0.85, alert when stuck.",
  trigger: "manual",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const masteryByCat: Record<string, number> = {};
      // Test/override hook: callers may pass byCategory mastery directly.
      const override = ctx.input?.byCategory as Record<string, number> | undefined;
      const benchTraces = override ? [] : await readTraces("benchmark", 1);
      const data = (benchTraces[0]?.result?.data ?? {}) as {
        perTask?: Array<{ category: string; passed: boolean }>;
        byCategory?: Record<string, { score: number }>;
      };
      if (override && typeof override === "object") {
        for (const [cat, score] of Object.entries(override)) {
          if (typeof score === "number") masteryByCat[cat] = score;
        }
      } else if (data.byCategory) {
        for (const [cat, c] of Object.entries(data.byCategory)) masteryByCat[cat] = c.score;
      } else {
        const byCat: Record<string, { pass: number; total: number }> = {};
        for (const t of data.perTask ?? []) {
          byCat[t.category] = byCat[t.category] ?? { pass: 0, total: 0 };
          byCat[t.category].total += 1;
          if (t.passed) byCat[t.category].pass += 1;
        }
        for (const [cat, c] of Object.entries(byCat)) masteryByCat[cat] = c.total ? c.pass / c.total : 0;
      }

      const curDir = path.join(argosRoot(), "data", "curriculum");
      const progress: Record<string, TopicProgress> = {};
      const advanced: string[] = [];
      const stuck: string[] = [];
      for (const [cat, mastery] of Object.entries(masteryByCat)) {
        const file = path.join(curDir, `${cat}-progress.json`);
        let p: TopicProgress = { attempts: 0, mastery: 0, level: 1, lowStreak: 0, status: "learning" };
        try {
          p = { ...p, ...(JSON.parse(await fsp.readFile(file, "utf8")) as Partial<TopicProgress>) };
        } catch {
          /* first attempt */
        }
        p.attempts += 1;
        p.mastery = mastery;
        if (mastery > 0.85) {
          p.level += 1;
          p.lowStreak = 0;
          p.status = "advanced";
          advanced.push(cat);
        } else if (mastery < 0.3) {
          p.lowStreak += 1;
          p.status = "struggling";
          if (p.lowStreak >= 5) stuck.push(cat);
        } else {
          p.lowStreak = 0;
          p.status = "learning";
        }
        try {
          await fsp.mkdir(curDir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await fsp.writeFile(tmp, JSON.stringify(p, null, 2), "utf8");
          await fsp.rename(tmp, file);
        } catch {
          /* persist best-effort */
        }
        progress[cat] = p;
      }

      let alerted = false;
      if (stuck.length > 0) {
        try {
          const d = await pushoverSend({
            title: "📚 ARGOS curriculum — stuck topic(s)",
            message: `Mastery < 0.3 after 5+ attempts: ${stuck.join(", ")}. Break these into smaller steps.`,
            priority: "0",
          });
          alerted = d.sent;
        } catch {
          /* alert best-effort */
        }
      }

      const ordered =
        Object.keys(masteryByCat).length > 0
          ? Object.entries(masteryByCat).sort((a, b) => b[1] - a[1]).map((x) => x[0])
          : ["format", "factual", "math", "logic", "reasoning"];
      return {
        loopId: "curriculum",
        loopNumber: 17,
        ok: true,
        summary:
          `order: ${ordered.join(" → ")}` +
          (advanced.length ? `; advanced ${advanced.join(",")}` : "") +
          (stuck.length ? `; STUCK ${stuck.join(",")}` : ""),
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { order: ordered, masteryByCat, progress, advanced, stuck, alerted, basis: Object.keys(masteryByCat).length ? "benchmark" : "static" },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("curriculum", 17, (e as Error).message, start);
    }
  },
};
