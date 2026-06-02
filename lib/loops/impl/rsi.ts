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
  description: "Propose a governed self-improvement (operator-approval gated).",
  trigger: "manual",
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
// The triple gate, made explicit. Applying an RSI change requires: (1) the
// eval gate to pass, (2) the benchmark to not regress, (3) operator approval.
// This loop does NOT apply — actual application is the governed approve-patch
// route's job (restore point + boundary + governance check). Here it reports
// the gate state for a candidate, and refuses governance targets outright.
export const rsiApply: LoopDefinition = {
  id: "rsi_apply",
  loopNumber: 2,
  name: "RSI Apply",
  description: "Triple-gated application of an approved RSI change (operator-gated).",
  trigger: "manual",
  governed: true,
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const target = inputStr(ctx, "target");
      const gateState = target ? checkRsiProposal({ kind: "patch", description: "rsi apply candidate", target }) : null;
      const note = target
        ? gateState!.allowed
          ? `Candidate "${target}" passes the rsi-gate. Application requires operator approval + a restore point via /api/loops/approve-patch. RSI never auto-applies.`
          : `Candidate "${target}" REFUSED by the rsi-gate: ${gateState!.reason}`
        : "No candidate target. RSI changes are applied only via the governed approve-patch route after operator approval.";
      return {
        loopId: "rsi_apply",
        loopNumber: 2,
        ok: true,
        summary: target ? (gateState!.allowed ? "candidate passes gate (operator must approve)" : "candidate refused by rsi-gate") : "no pending RSI application",
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [], // never proposes an auto-apply
        data: { target: target || null, gate: gateState, note },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("rsi_apply", 2, (e as Error).message, start);
    }
  },
};

// --- Loop3: Codebase Rewrite (Saturday 2AM) ---------------------------------
// Propose a full-file rewrite of a NON-governance source file. The proposal
// (kind "patch", payload = new file content) requires operator approval + a
// restore point; it is applied only by approve-patch. Refuses governance
// targets and anything outside the boundary.
export const codebaseRewrite: LoopDefinition = {
  id: "codebase_rewrite",
  loopNumber: 3,
  name: "Codebase Rewrite",
  description: "Propose a reviewed full-file rewrite (Saturday 2AM, operator-gated).",
  trigger: "scheduled",
  schedule: { dayOfWeek: 6, hour: 2, minute: 0, label: "Saturday 2AM" },
  governed: true,
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const target = inputStr(ctx, "target");
      const goal = inputStr(ctx, "goal") || "Improve clarity and add comments without changing behavior.";
      if (!target) {
        return {
          loopId: "codebase_rewrite",
          loopNumber: 3,
          ok: true,
          summary: "no target file — nothing proposed",
          claimedImprovement: false,
          claimedScore: null,
          benchmarkBefore: null,
          benchmarkAfter: null,
          evidence: [],
          proposals: [],
          data: { note: "Provide a target file to propose a rewrite. Governance files are refused." },
          error: null,
          durationMs: Date.now() - start,
        };
      }
      // Hard refusals BEFORE reading anything. (Governance targets are blocked
      // later by annotateRsiProposal unless ARGOS_RSI_ALLOW_GOVERNANCE is set.)
      if (!isWithinBoundary(target)) {
        return refusal(start, target, "outside the ARGOS_ROOT boundary");
      }
      const abs = path.isAbsolute(target) ? target : path.join(argosRoot(), target);
      let current = "";
      try {
        current = await fsp.readFile(abs, "utf8");
      } catch {
        return refusal(start, target, "file not found / unreadable");
      }
      if (current.length > 24_000) {
        return refusal(start, target, "file too large to safely rewrite in one pass (>24k chars)");
      }
      const rewritten = await loopModelCall(
        personaModel("bobby"),
        "You rewrite a source file to satisfy a goal WITHOUT changing its public behavior. Output ONLY the complete new file content — no markdown fences, no commentary.",
        `GOAL: ${goal}\n\nFILE (${target}):\n${current}`,
        { numPredict: 2000, temperature: 0.2, timeoutMs: 180_000 }
      );
      const proposed = rewritten.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
      const raw = {
        kind: "patch" as const,
        description: `Full-file rewrite of ${target}: ${goal}`,
        target,
        payload: proposed,
      };
      const annotated = annotateRsiProposal(raw);
      const blocked = annotated.description.startsWith("BLOCKED");
      return {
        loopId: "codebase_rewrite",
        loopNumber: 3,
        ok: true,
        summary: blocked
          ? `REFUSED — ${target} is governance code`
          : `proposed rewrite of ${target} (awaiting approval + restore)`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: blocked ? [] : [annotated],
        data: {
          target,
          goal,
          originalLength: current.length,
          proposedLength: proposed.length,
          refused: blocked,
          refusalReason: blocked ? annotated.description : null,
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
