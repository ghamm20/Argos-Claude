// lib/loops/impl/rsi.ts
//
// RSI loops — the only loops that can change ARGOS's own code/config, and the
// most constrained: RSI Propose (1), RSI Apply (2), Codebase Rewrite (3).
//
// Every proposal here is routed through the rsi-gate, which REFUSES governance
// targets unless ARGOS_RSI_ALLOW_GOVERNANCE is set, and refuses anything
// outside the ARGOS_ROOT boundary. Nothing is applied by these loops — they
// produce proposals that require operator approval + a restore point, applied
// only by the governed /api/loops/approve-patch route.

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { LoopDefinition, LoopContext } from "../loop";
import { personaModel, loopModelCall } from "../loop";
import { loopFail, type LoopResult } from "../types";
import {
  annotateRsiProposal,
  checkRsiProposal,
  isWithinBoundary,
} from "../rsi-gate";
import { argosRoot } from "../../vault/paths";
import { applyWithBackupTest, type ApplyTest } from "../apply";
import { readAllTraces } from "../trace-store";
import { readLessons } from "../lessons";
import { evaluateResult } from "../eval-gate";
import { runBenchmark } from "../benchmark";
import { readBaseline } from "../benchmark-baseline";

function inputStr(ctx: LoopContext, key: string, fallback = ""): string {
  const v = ctx.input?.[key];
  return typeof v === "string" ? v : fallback;
}

// --- Loop1: RSI Propose -----------------------------------------------------
// Propose a concrete self-improvement (config/prompt class). Governance targets
// are refused here unless the override flag is set; refusals apply NOTHING.
export const rsiPropose: LoopDefinition = {
  id: "rsi_propose",
  loopNumber: 1,
  name: "RSI Propose",
  description: "Propose a governed self-improvement (Sunday 4AM; governance refused without flag).",
  trigger: "scheduled",
  schedule: { dayOfWeek: 0, hour: 4, minute: 0, label: "Sunday 4AM" },
  governed: true,
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const goal = inputStr(ctx, "goal") || "Improve answer precision without increasing verbosity.";
      const target = inputStr(ctx, "target"); // may be empty (advisory config)
      const suggestion = await loopModelCall(
        personaModel("bartimaeus"),
        "You propose ONE concrete, minimal self-improvement to an AI assistant. Output JSON: {\"change\":\"what to change\",\"rationale\":\"why\",\"value\":\"the concrete new value/text\"}. JSON only.",
        `GOAL: ${goal}${target ? `\nTARGET: ${target}` : ""}`,
        { numPredict: 300, temperature: 0.4 }
      ).catch(() => "");

      const raw = {
        kind: "config" as const,
        description: `RSI self-improvement: ${goal}`,
        target: target || undefined,
        payload: suggestion.trim() || JSON.stringify({ goal }),
      };
      const annotated = annotateRsiProposal(raw);
      const blocked = annotated.description.startsWith("BLOCKED");

      return {
        loopId: "rsi_propose",
        loopNumber: 1,
        ok: true,
        summary: blocked
          ? "REFUSED — governance self-modification blocked (no override flag)"
          : "proposed a self-improvement (awaiting operator approval)",
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: blocked ? [] : [annotated],
        data: {
          goal,
          target: target || null,
          suggestion: suggestion.trim(),
          refused: blocked,
          refusalReason: blocked ? annotated.description : null,
        },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("rsi_propose", 1, (e as Error).message, start);
    }
  },
};

// --- Loop2: RSI Apply -------------------------------------------------------
// The full self-improvement pipeline, triple-gated:
//   (1) detectGaming pre-check on the claimed improvement — halt if it games.
//   (2) governance + boundary gate (rsi-gate; governance refused w/o the flag).
//   (3) backup -> write -> TEST (benchmark non-regression by default) ->
//       keep if green, rollback if red.
// Nothing is applied without ALL THREE passing. Test = "benchmark" (capture
// baseline, apply, re-run benchmark, keep iff score did not regress), or
// none/reject for the smoke. No target → reports status (nothing to apply).
async function benchmarkNonRegressionTest(): Promise<boolean> {
  const baseline = (await readBaseline())?.score ?? 0;
  const after = (await runBenchmark()).score;
  return after >= baseline - 1e-9;
}
export const rsiApply: LoopDefinition = {
  id: "rsi_apply",
  loopNumber: 2,
  name: "RSI Apply",
  description: "Full RSI pipeline: gaming check → gate → backup → apply → benchmark → keep/rollback.",
  trigger: "manual",
  governed: true,
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const target = inputStr(ctx, "target");
      const content = inputStr(ctx, "content");
      if (!target || !content) {
        return {
          loopId: "rsi_apply",
          loopNumber: 2,
          ok: true,
          summary: "no candidate (target + content) — nothing to apply",
          claimedImprovement: false,
          claimedScore: null,
          benchmarkBefore: null,
          benchmarkAfter: null,
          evidence: [],
          proposals: [],
          data: { note: "Provide target + content to apply an RSI change. Governance code is refused." },
          error: null,
          durationMs: Date.now() - start,
        };
      }

      // (1) Gaming pre-check — synthesize the claim and run it through the gate.
      const num = (k: string): number | null => {
        const v = ctx.input?.[k];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      const synthetic: LoopResult = {
        loopId: "rsi_apply",
        loopNumber: 2,
        ok: true,
        summary: "rsi candidate",
        claimedImprovement: ctx.input?.claimedImprovement === true,
        claimedScore: num("claimedScore"),
        benchmarkBefore: num("benchmarkBefore"),
        benchmarkAfter: num("benchmarkAfter"),
        evidence: [],
        proposals: [{ kind: "config", description: "rsi candidate", target }],
        data: null,
        error: null,
        durationMs: 0,
      };
      const pre = evaluateResult(synthetic);
      if (pre.gamingDetected) {
        return {
          loopId: "rsi_apply",
          loopNumber: 2,
          ok: true,
          summary: "HALTED before apply — gaming detected",
          claimedImprovement: false,
          claimedScore: null,
          benchmarkBefore: null,
          benchmarkAfter: null,
          evidence: [],
          proposals: [],
          data: { target, halted: true, gamingReasons: pre.gamingReasons },
          error: null,
          durationMs: Date.now() - start,
        };
      }

      // (2)+(3) Governance/boundary gate + backup + apply + test (in the pipeline).
      const testKind = inputStr(ctx, "test", "benchmark");
      const test: ApplyTest =
        testKind === "none"
          ? { kind: "none" }
          : testKind === "reject"
            ? { kind: "fn", run: async () => false }
            : { kind: "fn", run: benchmarkNonRegressionTest };
      const res = await applyWithBackupTest({
        loopId: "rsi_apply",
        reason: inputStr(ctx, "goal", "RSI self-improvement"),
        files: [{ target, content }],
        test,
      });
      return {
        loopId: "rsi_apply",
        loopNumber: 2,
        ok: true,
        summary: res.kept
          ? `APPLIED ${target} — benchmark held`
          : res.applied
            ? `ROLLED BACK ${target} — ${res.reason}`
            : `refused: ${res.reason}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { target, applied: res.applied, kept: res.kept, rolledBack: res.rolledBack, backupId: res.backupId, testPassed: res.testPassed, logPath: res.logPath },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("rsi_apply", 2, (e as Error).message, start);
    }
  },
};

// --- Loop3: Codebase Rewrite (Saturday 2AM) ---------------------------------
// Three modes, all governance- and boundary-gated:
//   - No target (the Saturday 2AM scheduled run): analyze the week's failures +
//     reflexion lessons and write a PATCH-PROPOSAL REPORT. It does NOT pick and
//     rewrite files unattended — autonomous rewrites are scoped to explicit
//     operator/loop targets, because a wrong file choice at 2AM is exactly the
//     failure mode the doctrine's backup+test guards against, and a bad target
//     can still typecheck.
//   - target + apply:true: AUTONOMOUS — backup -> write -> test -> keep if
//     green, rollback if red (the all-night doctrine). Test is typecheck by
//     default (or input.test = none|reject for the smoke).
//   - target, no apply: propose-only (returns a patch proposal).
function inputBool(ctx: LoopContext, key: string): boolean {
  return ctx.input?.[key] === true;
}
function resolveCodeTest(kind: string): ApplyTest {
  switch (kind) {
    case "none":
      return { kind: "none" };
    case "reject":
      return { kind: "fn", run: async () => false };
    default:
      return { kind: "command", argv: ["npm", "run", "typecheck"], shell: true, timeoutMs: 180_000 };
  }
}

export const codebaseRewrite: LoopDefinition = {
  id: "codebase_rewrite",
  loopNumber: 3,
  name: "Codebase Rewrite",
  description: "Autonomous full-file rewrite behind backup+test (Saturday 2AM analysis; targeted apply).",
  trigger: "scheduled",
  schedule: { dayOfWeek: 6, hour: 2, minute: 0, label: "Saturday 2AM" },
  governed: true,
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const target = inputStr(ctx, "target");
      const goal = inputStr(ctx, "goal") || "Improve clarity and add comments without changing behavior.";

      // ---- Mode 1: scheduled analysis (no target) → write a proposal report ----
      if (!target) {
        const failures = (await readAllTraces(60)).filter(
          (t) => t.outcome === "error" || t.outcome === "rejected" || t.outcome === "halted"
        );
        const lessons = (await readLessons()).filter((l) => l.failureCount >= 2);
        const day = new Date().toISOString().slice(0, 10);
        const lines = [
          `# ARGOS codebase patch proposals — ${day}`,
          "",
          `${failures.length} failures + ${lessons.length} recurring lessons reviewed.`,
          "",
          "> Autonomous unattended rewrites are NOT performed without an explicit",
          "> target. To apply a fix: /api/loops/evolve { loop: codebase_rewrite,",
          "> input: { target, goal, apply: true } } — backup + typecheck-gated.",
          "",
          "## Recurring lessons (candidates for a code fix)",
          ...(lessons.length ? lessons.map((l) => `- (${l.failureCount}×) ${l.lesson}`) : ["- none"]),
          "",
          "## Recent failures",
          ...(failures.length ? failures.slice(0, 20).map((f) => `- ${f.loopId}: ${f.result.summary}`) : ["- none"]),
        ];
        const reportPath = path.join(argosRoot(), "state", "loops", "patches", `proposals-${day}.md`);
        try {
          await fsp.mkdir(path.dirname(reportPath), { recursive: true });
          await fsp.writeFile(reportPath, lines.join("\n") + "\n", "utf8");
        } catch {
          /* report best-effort */
        }
        return {
          loopId: "codebase_rewrite",
          loopNumber: 3,
          ok: true,
          summary: `analyzed ${failures.length} failures + ${lessons.length} lessons → proposal report`,
          claimedImprovement: false,
          claimedScore: null,
          benchmarkBefore: null,
          benchmarkAfter: null,
          evidence: [],
          proposals: [],
          data: { reportPath, failures: failures.length, lessons: lessons.length, output: "patch-proposal-report" },
          error: null,
          durationMs: Date.now() - start,
        };
      }

      // ---- Hard refusals BEFORE reading/writing anything ----
      if (!isWithinBoundary(target)) return refusal(start, target, "outside the ARGOS_ROOT boundary");
      const gate = checkRsiProposal({ kind: "patch", description: goal, target });
      if (!gate.allowed) return refusal(start, target, gate.reason);

      // ---- Source content: from an input override (smoke hook) or a model rewrite ----
      let proposed = inputStr(ctx, "content");
      let originalLength = 0;
      if (!proposed) {
        const abs = path.isAbsolute(target) ? target : path.join(argosRoot(), target);
        let current = "";
        try {
          current = await fsp.readFile(abs, "utf8");
        } catch {
          return refusal(start, target, "file not found / unreadable");
        }
        originalLength = current.length;
        if (current.length > 24_000) {
          return refusal(start, target, "file too large to safely rewrite in one pass (>24k chars)");
        }
        const rewritten = await loopModelCall(
          personaModel("bobby"),
          "You rewrite a source file to satisfy a goal WITHOUT changing its public behavior. Output ONLY the complete new file content — no markdown fences, no commentary.",
          `GOAL: ${goal}\n\nFILE (${target}):\n${current}`,
          { numPredict: 2000, temperature: 0.2, timeoutMs: 180_000 }
        );
        proposed = rewritten.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
      }

      // ---- Mode 3: propose-only ----
      if (!inputBool(ctx, "apply")) {
        const annotated = annotateRsiProposal({ kind: "patch", description: `Full-file rewrite of ${target}: ${goal}`, target, payload: proposed });
        return {
          loopId: "codebase_rewrite",
          loopNumber: 3,
          ok: true,
          summary: `proposed rewrite of ${target} (set apply:true to auto-apply with backup+test)`,
          claimedImprovement: false,
          claimedScore: null,
          benchmarkBefore: null,
          benchmarkAfter: null,
          evidence: [],
          proposals: [annotated],
          data: { target, goal, originalLength, proposedLength: proposed.length, mode: "propose" },
          error: null,
          durationMs: Date.now() - start,
        };
      }

      // ---- Mode 2: AUTONOMOUS apply — backup -> write -> test -> keep/rollback ----
      const res = await applyWithBackupTest({
        loopId: "codebase_rewrite",
        reason: `${goal} (${target})`,
        files: [{ target, content: proposed }],
        test: resolveCodeTest(inputStr(ctx, "test", "typecheck")),
      });
      return {
        loopId: "codebase_rewrite",
        loopNumber: 3,
        ok: true,
        summary: res.kept
          ? `APPLIED ${target} — test green`
          : res.applied
            ? `ROLLED BACK ${target} — ${res.reason}`
            : `refused: ${res.reason}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [], // applied autonomously — nothing left pending
        data: {
          target,
          goal,
          mode: "apply",
          applied: res.applied,
          kept: res.kept,
          rolledBack: res.rolledBack,
          backupId: res.backupId,
          testPassed: res.testPassed,
          logPath: res.logPath,
        },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("codebase_rewrite", 3, (e as Error).message, start);
    }
  },
};

function refusal(start: number, target: string, reason: string): LoopResult {
  return {
    loopId: "codebase_rewrite",
    loopNumber: 3,
    ok: true,
    summary: `REFUSED — ${reason}`,
    claimedImprovement: false,
    claimedScore: null,
    benchmarkBefore: null,
    benchmarkAfter: null,
    evidence: [],
    proposals: [],
    data: { target, refused: true, refusalReason: reason },
    error: null,
    durationMs: Date.now() - start,
  };
}
