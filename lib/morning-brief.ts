// lib/morning-brief.ts
//
// Overnight Engine (2026-06-02) — the morning brief.
//
// Synthesizes everything that ran overnight (completed + failed in the last
// 24h) into a direct operational brief in Bartimaeus's voice, saves it to
// ARGOS_ROOT/output/morning-brief-YYYY-MM-DD.md, and fires a Pushover alert.
// Graceful: if the model is unavailable, a plain fallback brief is written so
// the operator always has something.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { callModel } from "./tools/util";
import { PERSONA_BY_ID } from "./personas";
import { pushoverSend } from "./research/alerts";
import { completeDir, failedDir } from "./task-queue";
import { outputDir } from "./tools/paths";
import { loopsBriefSection } from "./loops/brief";
// Phase 3 (2026-06-10) — Stage-16-style verdict block: deterministic
// GREEN/YELLOW/RED per task, every line carrying an evidence ref, plus
// hash-chain verification lines for the audit + observation chains.
import { verifyChain } from "./audit";
import { verifyObservationChain } from "./observation";

const BRIEF_SYSTEM =
  "You are Bartimaeus. Write a morning operational brief for the operator " +
  "covering what was accomplished overnight, what failed and why, and what " +
  "requires attention today. Be direct. No ceremony.";

export function briefPath(date: string): string {
  return path.join(outputDir(), `morning-brief-${date}.md`);
}

interface CompletedRec {
  taskId?: string;
  goal?: string;
  summary?: string;
  completedAt?: string;
  steps?: Array<{ tool_id: string; ok: boolean; skipped?: boolean }>;
}
interface FailedRec {
  id?: string;
  error?: unknown;
  at?: string;
}

/** Phase 3 — the deterministic verdict block. No model involved: verdicts are
 *  computed from result/error files and the two hash chains, and every line
 *  carries an evidence ref the operator can open. GREEN = all planned steps
 *  ok; YELLOW = partial (some ok, some failed/skipped); RED = task failed or
 *  zero steps succeeded. */
export async function buildVerdictBlock(
  completed: CompletedRec[],
  failed: FailedRec[]
): Promise<string> {
  const lines: string[] = ["## VERDICT BLOCK", ""];
  for (const c of completed) {
    const total = c.steps?.length ?? 0;
    const ok = (c.steps ?? []).filter((s) => s.ok).length;
    const verdict = total > 0 && ok === total ? "GREEN" : ok > 0 ? "YELLOW" : "RED";
    lines.push(
      `- ${verdict.padEnd(6)} ${c.taskId ?? "task"} "${(c.goal ?? "").slice(0, 70)}" — ${ok}/${total} steps ok  [result:tasks/complete/${c.taskId}-result.json]`
    );
  }
  for (const f of failed) {
    lines.push(
      `- RED    ${f.id ?? "task"} — FAILED: ${errText(f.error).slice(0, 120)}  [error:tasks/failed/${f.id}-error.json]`
    );
  }
  if (completed.length === 0 && failed.length === 0) {
    lines.push("- (no tasks ran in the window)");
  }
  // Chain verification — recomputed at brief time, never asserted from memory.
  try {
    const audit = await verifyChain();
    lines.push(
      `- ${audit.ok ? "GREEN " : "RED   "} audit chain: ${audit.totalEntries} entries, verify ${audit.ok ? "PASS" : `FAIL at index ${audit.brokenAtIndex} (${audit.brokenReason})`}  [audit:state/audit/chain.jsonl]`
    );
  } catch (e) {
    lines.push(`- RED    audit chain: verify threw — ${(e as Error).message}  [audit:state/audit/chain.jsonl]`);
  }
  try {
    const obs = await verifyObservationChain();
    lines.push(
      `- ${obs.ok ? "GREEN " : "RED   "} observation corpus: ${obs.totalEntries} entries, verify ${obs.ok ? "PASS" : `FAIL at index ${obs.brokenAtIndex} (${obs.brokenReason})`}  [obs:state/observation.jsonl]`
    );
  } catch (e) {
    lines.push(`- RED    observation corpus: verify threw — ${(e as Error).message}  [obs:state/observation.jsonl]`);
  }
  return lines.join("\n");
}

async function collectRecent(sinceMs: number): Promise<{ completed: CompletedRec[]; failed: FailedRec[] }> {
  const completed: CompletedRec[] = [];
  const failed: FailedRec[] = [];
  try {
    const names = (await fsp.readdir(completeDir())).filter((n) => n.endsWith("-result.json"));
    for (const n of names) {
      try {
        const r = JSON.parse(await fsp.readFile(path.join(completeDir(), n), "utf8")) as CompletedRec;
        const t = Date.parse(r.completedAt ?? "");
        if (Number.isFinite(t) && t >= sinceMs) completed.push(r);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no complete dir yet */
  }
  try {
    const names = (await fsp.readdir(failedDir())).filter((n) => n.endsWith("-error.json"));
    for (const n of names) {
      try {
        const r = JSON.parse(await fsp.readFile(path.join(failedDir(), n), "utf8")) as FailedRec;
        const t = Date.parse(r.at ?? "");
        if (Number.isFinite(t) && t >= sinceMs) failed.push(r);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no failed dir yet */
  }
  return { completed, failed };
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "error" in e) {
    const inner = (e as { error?: unknown }).error;
    return typeof inner === "string" ? inner : JSON.stringify(inner).slice(0, 200);
  }
  return JSON.stringify(e).slice(0, 200);
}

function fallbackBrief(completed: CompletedRec[], failed: FailedRec[]): string {
  const lines: string[] = [];
  lines.push(`Overnight: ${completed.length} task(s) completed, ${failed.length} failed.`);
  if (completed.length) {
    lines.push("\nCompleted:");
    for (const c of completed) lines.push(`- ${c.goal ?? c.taskId} — ${c.summary ?? "done"}`);
  }
  if (failed.length) {
    lines.push("\nFailed:");
    for (const f of failed) lines.push(`- ${f.id} — ${errText(f.error)}`);
  }
  if (!completed.length && !failed.length) lines.push("Quiet night — nothing ran.");
  return lines.join("\n");
}

export async function generateMorningBrief(
  opts: { now?: Date } = {}
): Promise<{ ok: boolean; path?: string; completed: number; failed: number; reason: string }> {
  const now = opts.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const { completed, failed } = await collectRecent(since);

  const user = [
    `Date: ${date}`,
    "",
    `COMPLETED (${completed.length}):`,
    ...completed.map((c) => {
      const okSteps = (c.steps ?? []).filter((s) => s.ok).length;
      const total = (c.steps ?? []).length;
      return `- ${c.goal ?? c.taskId}: ${c.summary ?? `${okSteps}/${total} steps`}`;
    }),
    "",
    `FAILED (${failed.length}):`,
    ...failed.map((f) => `- ${f.id}: ${errText(f.error)}`),
  ].join("\n");

  let brief = "";
  try {
    brief = await callModel(PERSONA_BY_ID.bartimaeus.model, BRIEF_SYSTEM, user, {
      timeoutMs: 120_000,
    });
  } catch {
    /* model unavailable — fall back */
  }
  if (!brief || !brief.trim()) brief = fallbackBrief(completed, failed);

  // Self-Evolving Loop Suite addendum — what the loops did overnight.
  const loopsSection = await loopsBriefSection(since).catch(() => "");

  // Phase 3 — verdict block FIRST (deterministic, evidence-ref'd); the model
  // prose follows. The operator reads verdicts before voice.
  const verdictBlock = await buildVerdictBlock(completed, failed).catch(
    (e) => `## VERDICT BLOCK\n\n- RED    verdict computation threw — ${(e as Error).message}`
  );

  const md = [
    `# Morning Brief — ${date}`,
    "",
    `_Generated ${now.toISOString()} · ${completed.length} complete · ${failed.length} failed_`,
    "",
    verdictBlock,
    "",
    brief.trim(),
    "",
    loopsSection,
    "",
  ].join("\n");

  try {
    await fsp.mkdir(outputDir(), { recursive: true });
    await fsp.writeFile(briefPath(date), md, "utf8");
  } catch (e) {
    return { ok: false, completed: completed.length, failed: failed.length, reason: (e as Error).message };
  }

  // Pushover (best-effort).
  try {
    await pushoverSend({
      title: "Morning Brief Ready",
      message: `${completed.length} tasks complete, ${failed.length} failed. Check ARGOS.`,
      priority: "0",
    });
  } catch {
    /* alert best-effort */
  }

  return { ok: true, path: briefPath(date), completed: completed.length, failed: failed.length, reason: "generated" };
}

export async function getLatestBrief(): Promise<{ date: string; content: string; path: string } | null> {
  try {
    const names = (await fsp.readdir(outputDir()))
      .filter((n) => /^morning-brief-\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort();
    if (names.length === 0) return null;
    const newest = names[names.length - 1];
    const content = await fsp.readFile(path.join(outputDir(), newest), "utf8");
    return { date: newest.replace(/^morning-brief-|\.md$/g, ""), content, path: path.join(outputDir(), newest) };
  } catch {
    return null;
  }
}
