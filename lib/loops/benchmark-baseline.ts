// lib/loops/benchmark-baseline.ts
//
// Self-Evolving Loop Suite — the benchmark is ground truth, so it is also the
// regression tripwire. This module persists the weekly baseline + every run,
// compares per-category scores, and — when a category drops more than the
// threshold — auto-rolls-back the most recent applied patch and alerts.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { rollbackLoopBackup } from "./backup";
import { readPatchRecords } from "./apply";
import { pushoverSend } from "../research/alerts";
import type { BenchmarkScore, ByCategory } from "./benchmark";

/** A category must not drop by more than this fraction vs baseline. */
export const REGRESSION_THRESHOLD = 0.1;

export function benchmarksDir(): string {
  return path.join(argosRoot(), "state", "loops", "benchmarks");
}
function baselinePath(): string {
  return path.join(benchmarksDir(), "baseline.json");
}

export async function saveBenchmarkRun(score: BenchmarkScore): Promise<string | null> {
  try {
    await fsp.mkdir(benchmarksDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(benchmarksDir(), `run-${stamp}.json`);
    await fsp.writeFile(file, JSON.stringify(score, null, 2), "utf8");
    return file;
  } catch {
    return null;
  }
}

export async function readBaseline(): Promise<BenchmarkScore | null> {
  try {
    return JSON.parse(await fsp.readFile(baselinePath(), "utf8")) as BenchmarkScore;
  } catch {
    return null;
  }
}

export async function saveBaseline(score: BenchmarkScore): Promise<boolean> {
  try {
    await fsp.mkdir(benchmarksDir(), { recursive: true });
    const tmp = `${baselinePath()}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(score, null, 2), "utf8");
    await fsp.rename(tmp, baselinePath());
    return true;
  } catch {
    return false;
  }
}

export interface CategoryRegression {
  category: string;
  baseline: number;
  current: number;
  drop: number;
}

/** Categories whose score dropped by more than `threshold` vs baseline. */
export function detectCategoryRegression(
  current: ByCategory,
  baseline: ByCategory,
  threshold = REGRESSION_THRESHOLD
): CategoryRegression[] {
  const out: CategoryRegression[] = [];
  for (const [cat, base] of Object.entries(baseline)) {
    const cur = current[cat];
    if (!cur) continue;
    const drop = base.score - cur.score;
    if (drop > threshold + 1e-9) {
      out.push({ category: cat, baseline: base.score, current: cur.score, drop });
    }
  }
  return out;
}

export interface RegressionAction {
  regressed: CategoryRegression[];
  rolledBackBackupId: string | null;
  rolledBackLoopId: string | null;
  alerted: boolean;
  note: string;
}

/**
 * The benchmark dropped on at least one category. Roll back the MOST RECENT
 * applied patch (the most likely culprit) and alert the operator. If there is
 * no applied patch to undo, just alert. Append-only logged.
 */
export async function handleRegression(
  regressed: CategoryRegression[]
): Promise<RegressionAction> {
  let rolledBackBackupId: string | null = null;
  let rolledBackLoopId: string | null = null;
  let note = "regression detected";

  try {
    const applied = (await readPatchRecords("APPLIED", 14)) as Array<{
      at?: string;
      backupId?: string;
      loopId?: string;
    }>;
    applied.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const latest = applied.find((p) => p.backupId);
    if (latest?.backupId) {
      const rb = await rollbackLoopBackup(latest.backupId);
      if (rb.ok) {
        rolledBackBackupId = latest.backupId;
        rolledBackLoopId = latest.loopId ?? null;
        note = `rolled back the most recent applied patch (${latest.loopId ?? "?"}) from backup ${latest.backupId}`;
      } else {
        note = `regression detected but rollback failed: ${rb.reason}`;
      }
    } else {
      note = "regression detected; no applied patch to roll back";
    }
  } catch (e) {
    note = `regression handling error: ${(e as Error).message}`;
  }

  // Log the regression event (append-only).
  try {
    await fsp.mkdir(benchmarksDir(), { recursive: true });
    await fsp.appendFile(
      path.join(benchmarksDir(), "regression-rollbacks.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), regressed, rolledBackBackupId, rolledBackLoopId, note }) + "\n",
      "utf8"
    );
  } catch {
    /* best effort */
  }

  // Alert.
  let alerted = false;
  try {
    const lines = regressed
      .map((r) => `${r.category}: ${(r.baseline * 100).toFixed(0)}% → ${(r.current * 100).toFixed(0)}%`)
      .join("\n");
    const delivery = await pushoverSend({
      title: "⛔ ARGOS benchmark regression — auto-rolled back",
      message: `Categories dropped >${(REGRESSION_THRESHOLD * 100).toFixed(0)}%:\n${lines}\n\n${note}`,
      priority: "1",
    });
    alerted = delivery.sent;
  } catch {
    /* alert is best-effort */
  }

  return { regressed, rolledBackBackupId, rolledBackLoopId, alerted, note };
}
