// lib/loops/impl/agents.ts
//
// Multi-agent loops: Multi-Agent Debate (10), Red/Blue Team (18),
// World Model (15). These coordinate the persona models against each other.
// All informational — they produce analysis, not change.

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { LoopDefinition, LoopContext } from "../loop";
import { personaModel, loopModelCall } from "../loop";
import { loopFail, type LoopResult } from "../types";
import { argosRoot } from "../../vault/paths";
import { pushoverSend } from "../../research/alerts";

function inputStr(ctx: LoopContext, key: string, fallback = ""): string {
  const v = ctx.input?.[key];
  return typeof v === "string" ? v : fallback;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "topic";
}

/** Heuristic: should this content auto-trigger a multi-agent debate? (threat
 *  assessments, contracts, incidents — high-stakes calls worth four views.) */
export function shouldAutoDebate(text: string): boolean {
  return /\b(threat|contract|incident|breach|liability|risk assessment|legal|lawsuit|terminat|escalat)\b/i.test(text ?? "");
}

// --- Loop10: Multi-Agent Debate (/debate) -----------------------------------
// Bobby, Juniper, and Sage each argue a position; Bartimaeus judges and
// synthesizes. One model loaded at a time (sequential).
export const multiAgentDebate: LoopDefinition = {
  id: "multi_agent_debate",
  loopNumber: 10,
  name: "Multi-Agent Debate",
  description: "Builder→Critic→Verifier→Judge across Bobby/Juniper/Sage/Bartimaeus (/debate).",
  trigger: "command",
  command: "debate",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const topic = inputStr(ctx, "topic");
      if (!topic) return loopFail("multi_agent_debate", 10, "no topic provided", start);
      const oops = (e: unknown) => `(unavailable: ${(e as Error).message})`;
      // Sequential pipeline: each role sees the prior ones.
      const builder = (
        await loopModelCall(
          personaModel("bobby"),
          "You are the BUILDER. Propose a concrete answer or plan for the topic in 2-3 sentences. Be decisive — commit to a position.",
          `TOPIC: ${topic}`,
          { numPredict: 240, temperature: 0.5 }
        ).catch(oops)
      ).trim();
      const critic = (
        await loopModelCall(
          personaModel("juniper"),
          "You are the CRITIC. Attack the builder's proposal — name its single weakest point and why, in 2-3 sentences.",
          `TOPIC: ${topic}\n\nBUILDER: ${builder}`,
          { numPredict: 240, temperature: 0.6 }
        ).catch(oops)
      ).trim();
      const verifier = (
        await loopModelCall(
          personaModel("sage"),
          "You are the VERIFIER. Weigh the proposal against the critique: what holds up, what doesn't, and what evidence is missing? 2-3 sentences.",
          `TOPIC: ${topic}\n\nBUILDER: ${builder}\n\nCRITIC: ${critic}`,
          { numPredict: 260, temperature: 0.4 }
        ).catch(oops)
      ).trim();
      const judge = (
        await loopModelCall(
          personaModel("bartimaeus"),
          "You are the JUDGE. Given the builder, critic, and verifier, deliver the final decision and your confidence in it. 3-4 sentences. No hedging.",
          `TOPIC: ${topic}\n\nBUILDER: ${builder}\n\nCRITIC: ${critic}\n\nVERIFIER: ${verifier}`,
          { numPredict: 320, temperature: 0.4 }
        ).catch(oops)
      ).trim();
      return {
        loopId: "multi_agent_debate",
        loopNumber: 10,
        ok: true,
        summary: `debate on "${topic.slice(0, 60)}" — builder→critic→verifier→judge`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: {
          topic,
          roles: { builder, critic, verifier, judge },
          verdict: judge,
          output: judge,
          autoTriggered: shouldAutoDebate(topic),
        },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("multi_agent_debate", 10, (e as Error).message, start);
    }
  },
};

// --- Loop18: Red/Blue Team (Friday 11PM) ------------------------------------
// Juniper = red (attack/find the flaw), Sage = blue (defend/harden),
// Bartimaeus = judge. Default target is a security posture review.
export const redBlueTeam: LoopDefinition = {
  id: "red_blue_team",
  loopNumber: 18,
  name: "Red/Blue Team",
  description: "Juniper red, Sage blue, Bartimaeus judge (Friday 11PM).",
  trigger: "scheduled",
  schedule: { dayOfWeek: 5, hour: 23, minute: 0, label: "Friday 11PM" },
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const target =
        inputStr(ctx, "target") ||
        "ARGOS's current security posture: local-only, USB-native, governed tool execution, append-only audit.";
      const red = await loopModelCall(
        personaModel("juniper"),
        "You are the RED team. Find the single most plausible weakness or attack vector in the target. State it concretely in 2-3 sentences.",
        `TARGET: ${target}`,
        { numPredict: 240, temperature: 0.6 }
      ).catch((e) => `(red unavailable: ${(e as Error).message})`);
      const blue = await loopModelCall(
        personaModel("sage"),
        "You are the BLUE team. Given the red team's finding, propose a concrete mitigation/hardening. 2-3 sentences.",
        `TARGET: ${target}\n\nRED FINDING: ${red}`,
        { numPredict: 240, temperature: 0.5 }
      ).catch((e) => `(blue unavailable: ${(e as Error).message})`);
      const judgment = await loopModelCall(
        personaModel("bartimaeus"),
        "You are Bartimaeus, judging a red/blue exercise. Is the red finding real and is the blue mitigation sufficient? Give a verdict + one recommended next step. 3-4 sentences.",
        `TARGET: ${target}\n\nRED: ${red}\n\nBLUE: ${blue}`,
        { numPredict: 300, temperature: 0.4 }
      ).catch((e) => `(judge unavailable: ${(e as Error).message})`);
      // Write a dated report.
      const day = new Date().toISOString().slice(0, 10);
      const reportPath = path.join(argosRoot(), "state", "loops", "red-blue", `${day}-${slugify(target)}.md`);
      try {
        await fsp.mkdir(path.dirname(reportPath), { recursive: true });
        await fsp.writeFile(
          reportPath,
          [`# Red/Blue exercise — ${day}`, "", `**Target:** ${target}`, "", "## Red (Juniper)", red.trim(), "", "## Blue (Sage)", blue.trim(), "", "## Judgment (Bartimaeus)", judgment.trim(), ""].join("\n"),
          "utf8"
        );
      } catch {
        /* report best-effort */
      }

      // Critical finding → page the operator.
      const critical = /\b(critical|severe|high[- ]risk|exploitable|urgent|immediately)\b/i.test(`${red} ${judgment}`);
      let alerted = false;
      if (critical) {
        try {
          const d = await pushoverSend({
            title: "🛡 ARGOS red/blue — critical finding",
            message: `Target: ${target}\n\nRED: ${red.trim().slice(0, 300)}\n\nJUDGE: ${judgment.trim().slice(0, 300)}`,
            priority: "1",
          });
          alerted = d.sent;
        } catch {
          /* alert best-effort */
        }
      }

      return {
        loopId: "red_blue_team",
        loopNumber: 18,
        ok: true,
        summary: `red/blue on "${target.slice(0, 50)}" — judged${critical ? " (CRITICAL)" : ""}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { target, red: red.trim(), blue: blue.trim(), judgment: judgment.trim(), output: judgment.trim(), critical, alerted, reportPath },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("red_blue_team", 18, (e as Error).message, start);
    }
  },
};

// --- Loop15: World Model (/simulate) ----------------------------------------
// Predict the likely outcomes, second-order effects, and risks of an action
// BEFORE taking it. Bartimaeus reasons forward.
export const worldModel: LoopDefinition = {
  id: "world_model",
  loopNumber: 15,
  name: "World Model",
  description: "Predict an action's outcomes + risks before taking it (/simulate).",
  trigger: "command",
  command: "simulate",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const action = inputStr(ctx, "action") || inputStr(ctx, "scenario");
      if (!action) return loopFail("world_model", 15, "no action/scenario provided", start);
      const prediction = await loopModelCall(
        personaModel("bartimaeus"),
        "You are a world model. Given a proposed action, predict: (1) the most likely outcome, (2) two plausible second-order effects, (3) the main risk. Be concrete. Use short labelled lines.",
        `PROPOSED ACTION: ${action}`,
        { numPredict: 380, temperature: 0.4 }
      );
      return {
        loopId: "world_model",
        loopNumber: 15,
        ok: prediction.trim().length > 0,
        summary: `simulated outcome of: ${action.slice(0, 70)}`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { action, prediction: prediction.trim() },
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return loopFail("world_model", 15, (e as Error).message, start);
    }
  },
};
