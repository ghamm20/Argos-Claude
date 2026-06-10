// lib/verifier/judge.ts
//
// Stage 9 (2026-06-09) — the Judge. Validates Claims against ground truth.
// MECHANICAL checks first (cheap, deterministic, un-foolable): does the file
// exist at the path? did the task actually change state? Model judgment is used
// ONLY where mechanics can't reach (a "none" check), and runs on a DIFFERENT
// model than the executor (hermes3) — the registry "judge" role (gemma-4 lean /
// qwen3 mid) — so the grader isn't the gradee.

import { existsSync } from "node:fs";
import { resolveWithinRoot } from "../tools/fs-guard";
import { getTask } from "../tasks/store";
import { getGpuProfile } from "../gpu/detect";
import { resolveModelForRole, listInstalledModels } from "../models/registry";
import { getOllamaBase } from "../ollama-config";
import type { Claim, Outcome } from "./schema";

export type JudgeGenerate = (model: string, prompt: string) => Promise<string>;

const realJudgeGenerate: JudgeGenerate = async (model, prompt) => {
  const res = await fetch(`${getOllamaBase()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false, think: false }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = (await res.json()) as { message?: { content?: string } };
  return (j.message?.content ?? "").trim();
};

/** Judge ONE claim. Mechanical where possible; model only for "none". */
export async function judgeClaim(claim: Claim, opts: { generate?: JudgeGenerate } = {}): Promise<Outcome> {
  const at = new Date().toISOString();
  const c = claim.check;

  if (c.type === "file_exists" || c.type === "file_absent") {
    const r = resolveWithinRoot(c.path);
    const exists = r.ok && existsSync(r.abs);
    const want = c.type === "file_exists";
    const verdict = exists === want ? "verified" : "failed";
    return { claimId: claim.id, at, verdict, method: "mechanical", evidence: `${c.type}(${c.path}) → exists=${exists}` };
  }

  if (c.type === "task_status") {
    const t = await getTask(c.taskId);
    const verdict = t && t.status === c.expected ? "verified" : "failed";
    return { claimId: claim.id, at, verdict, method: "mechanical", evidence: `task ${c.taskId} status=${t?.status ?? "missing"} expected=${c.expected}` };
  }

  // c.type === "none" → model judgment (mechanics can't reach). Stub/disabled →
  // unverified (NEVER asserts "verified" without evidence).
  const generate = opts.generate ?? (process.env.ARGOS_JUDGE_STUB ? stubJudge : realJudgeGenerate);
  if (!generate) return { claimId: claim.id, at, verdict: "unverified", method: "model", evidence: "no judge model available" };
  try {
    const profile = await getGpuProfile().catch(() => null);
    const installed = await listInstalledModels().catch(() => new Set<string>());
    const judgeModel = profile ? (await resolveModelForRole("judge", profile, { installed })).model : "judge";
    const prompt = `You are a strict verifier. A system CLAIMED: "${claim.assertion}". Reply with exactly one word — VERIFIED if it is clearly true, FAILED if false, or UNSURE. Do not explain.`;
    const out = (await generate(judgeModel, prompt)).toUpperCase();
    const verdict = out.includes("VERIFIED") ? "verified" : out.includes("FAILED") ? "failed" : "unverified";
    return { claimId: claim.id, at, verdict, method: "model", evidence: `judge(${judgeModel}) → ${out.slice(0, 40)}`, judgeModel };
  } catch (e) {
    return { claimId: claim.id, at, verdict: "unverified", method: "model", evidence: `judge error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Deterministic stub: FAILED only when the CLAIM itself reads as a negation /
// fabrication (these phrases appear in a false assertion, NOT in the instruction
// template — which is why bare "false" is excluded: it occurs in "FAILED if
// false").
const stubJudge: JudgeGenerate = async (_m, prompt) =>
  /did not|never happened|fabricat|does not exist|no such/i.test(prompt) ? "FAILED" : "VERIFIED";

export async function judgeClaims(claims: Claim[], opts: { generate?: JudgeGenerate } = {}): Promise<Outcome[]> {
  return Promise.all(claims.map((c) => judgeClaim(c, opts)));
}
