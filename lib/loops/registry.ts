// lib/loops/registry.ts
//
// Self-Evolving Loop Suite (2026-06-02) — the registry of all 20 loops,
// ordered by loop number, with lookup helpers for the scheduler, the command
// router (/refine, /debate, /simulate), and the status API/UI.

import type { LoopDefinition } from "./loop";
import type { LoopId } from "./types";
import { reflexion, selfRefine, traceAnalysis, metaOptimizer } from "./impl/reflective";
import {
  memoryConsolidation,
  ouroborosRag,
  skillAcquisition,
  activeLearning,
} from "./impl/memory";
import {
  promptOptimizer,
  evolutionary,
  rewardOptimization,
  curriculum,
} from "./impl/optimize";
import { multiAgentDebate, redBlueTeam, worldModel } from "./impl/agents";
import { selfTraining, benchmark } from "./impl/training";
import { rsiPropose, rsiApply, codebaseRewrite } from "./impl/rsi";

/** All 20 loops, ordered by loop number (1..20). */
export const LOOPS: LoopDefinition[] = [
  rsiPropose, //          1
  rsiApply, //            2
  codebaseRewrite, //     3
  traceAnalysis, //       4
  evolutionary, //        5
  promptOptimizer, //     6
  reflexion, //           7
  selfRefine, //          8
  ouroborosRag, //        9
  multiAgentDebate, //    10
  memoryConsolidation, // 11
  skillAcquisition, //    12
  selfTraining, //        13
  rewardOptimization, //  14
  worldModel, //          15
  activeLearning, //      16
  curriculum, //          17
  redBlueTeam, //         18
  benchmark, //           19
  metaOptimizer, //       20
];

export const LOOP_BY_ID: Record<LoopId, LoopDefinition> = Object.fromEntries(
  LOOPS.map((l) => [l.id, l])
) as Record<LoopId, LoopDefinition>;

export function getLoop(id: string): LoopDefinition | null {
  return (LOOP_BY_ID as Record<string, LoopDefinition>)[id] ?? null;
}

/** Resolve a loop by its chat command (e.g. "refine", "debate", "simulate"). */
export function getLoopByCommand(command: string): LoopDefinition | null {
  const c = command.trim().toLowerCase();
  return LOOPS.find((l) => l.command === c) ?? null;
}

/** Loops that run on a schedule (for the scheduler tick). */
export function scheduledLoops(): LoopDefinition[] {
  return LOOPS.filter((l) => l.trigger === "scheduled" && l.schedule);
}

export interface LoopSummary {
  id: LoopId;
  loopNumber: number;
  name: string;
  description: string;
  trigger: LoopDefinition["trigger"];
  command: string | null;
  schedule: string | null;
  governed: boolean;
}

/** Lightweight summaries for the status API + loops page. */
export function loopSummaries(): LoopSummary[] {
  return LOOPS.map((l) => ({
    id: l.id,
    loopNumber: l.loopNumber,
    name: l.name,
    description: l.description,
    trigger: l.trigger,
    command: l.command ?? null,
    schedule: l.schedule?.label ?? null,
    governed: Boolean(l.governed),
  }));
}
