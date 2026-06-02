// lib/loops/impl/agents.ts
//
// Multi-agent loops: Multi-Agent Debate (10), Red/Blue Team (18),
// World Model (15). These coordinate the persona models against each other.
// All informational — they produce analysis, not change.

import type { LoopDefinition, LoopContext } from "../loop";
import { personaModel, loopModelCall } from "../loop";
import { loopFail, type LoopResult } from "../types";

function inputStr(ctx: LoopContext, key: string, fallback = ""): string {
  const v = ctx.input?.[key];
  return typeof v === "string" ? v : fallback;
}

// --- Loop10: Multi-Agent Debate (/debate) -----------------------------------
// Bobby, Juniper, and Sage each argue a position; Bartimaeus judges and
// synthesizes. One model loaded at a time (sequential).
export const multiAgentDebate: LoopDefinition = {
  id: "multi_agent_debate",
  loopNumber: 10,
  name: "Multi-Agent Debate",
  description: "Bobby/Juniper/Sage debate; Bartimaeus judges (/debate).",
  trigger: "command",
  command: "debate",
  async run(ctx): Promise<LoopResult> {
    const start = Date.now();
    try {
      const topic = inputStr(ctx, "topic");
      if (!topic) return loopFail("multi_agent_debate", 10, "no topic provided", start);
      const debaters: Array<{ persona: "bobby" | "juniper" | "sage"; angle: string }> = [
        { persona: "bobby", angle: "the pragmatic, ship-it position" },
        { persona: "juniper", angle: "the grounded, human-centered position" },
        { persona: "sage", angle: "the rigorous, risk-aware position" },
      ];
      const positions: Array<{ persona: string; argument: string }> = [];
      for (const d of debaters) {
        const arg = await loopModelCall(
          personaModel(d.persona),
          `You are debating. Argue ${d.angle} on the topic in 2-3 sentences. Be specific and committed.`,
          `TOPIC: ${topic}`,
          { numPredict: 220, temperature: 0.6 }
        ).catch((e) => `(unavailable: ${(e as Error).message})`);
        positions.push({ persona: d.persona, argument: arg.trim() });
      }
      const transcript = positions
        .map((p) => `${p.persona.toUpperCase()}: ${p.argument}`)
        .join("\n\n");
      const verdict = await loopModelCall(
        personaModel("bartimaeus"),
        "You are Bartimaeus, judging a debate. Weigh the positions, name the strongest, and give a synthesized conclusion in 3-4 sentences.",
        `TOPIC: ${topic}\n\n${transcript}`,
        { numPredict: 320, temperature: 0.4 }
      ).catch((e) => `(judge unavailable: ${(e as Error).message})`);
      return {
        loopId: "multi_agent_debate",
        loopNumber: 10,
        ok: true,
        summary: `debate on "${topic.slice(0, 60)}" — ${positions.length} positions judged`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { topic, positions, verdict: verdict.trim() },
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
      return {
        loopId: "red_blue_team",
        loopNumber: 18,
        ok: true,
        summary: `red/blue exercise on target — judged`,
        claimedImprovement: false,
        claimedScore: null,
        benchmarkBefore: null,
        benchmarkAfter: null,
        evidence: [],
        proposals: [],
        data: { target, red: red.trim(), blue: blue.trim(), judgment: judgment.trim() },
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
