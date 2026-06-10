// lib/integrity/stress.ts
//
// Stage 5 / v2.4.3 (2026-06-09) — integrity MEASUREMENT. Drives the adversarial
// corpus through the REAL guards (parseToolCalls, evaluateIntegrity,
// detectMisrepresentation — the exact functions the chat route uses) and scores
// guard-caught vs guard-missed. Stops asserting integrity; starts measuring it.
//
// Deterministic — no model. Each corpus case supplies a crafted assistant
// message + context; we measure whether the guard CATCHES the known-bad case
// (and does NOT false-fire on a control). This measures the GUARD, which is what
// we control; whether a model fabricates is a separate question.
//
// Results append to state/integrity-metrics.jsonl (timestamp + commit hash);
// rolling metrics (catch / miss / false-positive rate, per-guard, 7-day trend)
// are computed from that log.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";
// Build-time version stamp for scheduled runs (same pattern as runtime-info).
import pkg from "../../package.json";
const BUILD_VERSION = (pkg as { version?: string }).version ?? "0.0.0";
import { parseToolCalls } from "../tools/chat-tools";
import { toolSummaries } from "../tools/registry";
import {
  evaluateIntegrity,
  detectMisrepresentation,
  hasMalformedToolTag,
  isNegativeStateResult,
  type ToolResultLike,
} from "../tool-integrity";

const KNOWN_TOOL_IDS = toolSummaries().map((t) => t.id);

export type GuardName =
  | "structural_integrity"
  | "misrepresentation"
  | "parser_failure"
  | "parser_call"
  | "none";

export interface CorpusCase {
  id: string;
  category: string;
  input: {
    text: string;
    toolRan?: boolean;
    hadGrounding?: boolean;
    explicitToolRequest?: boolean;
    attemptedToolButFailed?: boolean;
    toolResults?: ToolResultLike[];
  };
  expect: { guard: GuardName; shouldFlag: boolean; auditKind: string };
}

export interface CaseResult {
  id: string;
  category: string;
  expectedGuard: GuardName;
  shouldFlag: boolean;
  outcome: "caught" | "missed" | "correct_pass" | "false_positive";
  fired: { structural: boolean; misrep: boolean; parserFailure: boolean; parserCall: boolean };
}

/** Evaluate one case through the real guards (mirrors /api/tools/parse-test). */
export function evalCaseGuards(input: CorpusCase["input"]): CaseResult["fired"] {
  const text = input.text ?? "";
  const { calls, failures } = parseToolCalls(text);
  const verdict = evaluateIntegrity(text, {
    toolRan: input.toolRan === true,
    hadGrounding: input.hadGrounding === true,
    explicitToolRequest: input.explicitToolRequest === true,
    attemptedToolButFailed:
      input.attemptedToolButFailed === true ||
      failures.length > 0 ||
      hasMalformedToolTag(text, KNOWN_TOOL_IDS),
  });
  const negatives = (input.toolResults ?? []).filter(isNegativeStateResult);
  const misrep = detectMisrepresentation(text, negatives);
  return {
    structural: verdict.violation,
    misrep: misrep.violation,
    parserFailure: failures.length > 0,
    parserCall: calls.length > 0,
  };
}

function scoreOne(c: CorpusCase): CaseResult {
  const fired = evalCaseGuards(c.input);
  const caughtBy: Record<GuardName, boolean> = {
    structural_integrity: fired.structural,
    misrepresentation: fired.misrep,
    parser_failure: fired.parserFailure,
    parser_call: fired.parserCall,
    none: false,
  };
  let outcome: CaseResult["outcome"];
  if (c.expect.guard === "none") {
    // Control: the INTEGRITY guards must not false-fire. (A clean tool call is
    // parsed — that's correct, not a violation — so parser firing is fine here.)
    outcome = !fired.structural && !fired.misrep ? "correct_pass" : "false_positive";
  } else {
    outcome = caughtBy[c.expect.guard] ? "caught" : "missed";
  }
  return {
    id: c.id,
    category: c.category,
    expectedGuard: c.expect.guard,
    shouldFlag: c.expect.shouldFlag,
    outcome,
    fired,
  };
}

export interface StressReport {
  at: string;
  commit: string;
  total: number;
  positives: number;
  caught: number;
  missed: number;
  controls: number;
  falsePositives: number;
  catchRate: number; // caught / positives
  missRate: number;
  falsePositiveRate: number; // falsePositives / controls
  byGuard: Record<string, { total: number; caught: number }>;
  byCategory: Record<string, { total: number; ok: number }>;
  // Misses + false positives, individually, WITH the fired-guard evidence — a
  // miss is a FINDING, never summarized away.
  findings: CaseResult[];
  cases: CaseResult[];
}

export function scoreCorpus(cases: CorpusCase[], commit: string, at: string): StressReport {
  const results = cases.map(scoreOne);
  const positives = results.filter((r) => r.expectedGuard !== "none");
  const controls = results.filter((r) => r.expectedGuard === "none");
  const caught = positives.filter((r) => r.outcome === "caught").length;
  const falsePositives = controls.filter((r) => r.outcome === "false_positive").length;

  const byGuard: Record<string, { total: number; caught: number }> = {};
  for (const r of positives) {
    const g = (byGuard[r.expectedGuard] ??= { total: 0, caught: 0 });
    g.total += 1;
    if (r.outcome === "caught") g.caught += 1;
  }
  const byCategory: Record<string, { total: number; ok: number }> = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { total: 0, ok: 0 });
    c.total += 1;
    if (r.outcome === "caught" || r.outcome === "correct_pass") c.ok += 1;
  }
  return {
    at,
    commit,
    total: results.length,
    positives: positives.length,
    caught,
    missed: positives.length - caught,
    controls: controls.length,
    falsePositives,
    catchRate: positives.length ? caught / positives.length : 1,
    missRate: positives.length ? (positives.length - caught) / positives.length : 0,
    falsePositiveRate: controls.length ? falsePositives / controls.length : 0,
    byGuard,
    byCategory,
    findings: results.filter((r) => r.outcome === "missed" || r.outcome === "false_positive"),
    cases: results,
  };
}

// ---------------------------------------------------------------------------
// Corpus loading + metrics persistence
// ---------------------------------------------------------------------------

export function corpusPath(): string {
  return path.join(process.cwd(), "scripts", "integrity-corpus.jsonl");
}
export function metricsPath(): string {
  return path.join(argosRoot(), "state", "integrity-metrics.jsonl");
}

export async function loadCorpus(): Promise<CorpusCase[]> {
  const raw = await fsp.readFile(corpusPath(), "utf8");
  const out: CorpusCase[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as CorpusCase);
    } catch {
      /* skip malformed corpus line */
    }
  }
  return out;
}

/** Append a stress report's summary to the metrics log (one line per run). */
export async function appendMetrics(report: StressReport): Promise<void> {
  const summary = {
    at: report.at,
    commit: report.commit,
    total: report.total,
    positives: report.positives,
    caught: report.caught,
    missed: report.missed,
    controls: report.controls,
    falsePositives: report.falsePositives,
    catchRate: report.catchRate,
    falsePositiveRate: report.falsePositiveRate,
    byGuard: report.byGuard,
    missedIds: report.findings.map((f) => f.id),
  };
  const p = metricsPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.appendFile(p, JSON.stringify(summary) + "\n", "utf8");
}

/** Run the corpus in-process and persist the metrics. Used by the scheduler +
 *  the /api/integrity/stress endpoint. */
export async function runStress(commit: string, at: string): Promise<StressReport> {
  const cases = await loadCorpus();
  const report = scoreCorpus(cases, commit, at);
  await appendMetrics(report).catch(() => {});
  return report;
}

/** Schedule hook (Stage 5) — run the stress once per UTC day, reusing the
 *  existing heartbeat tick (no new scheduler). Idempotent: the metrics log's
 *  last entry date is the source of truth, so it survives restarts and won't
 *  double-run a day. Corpus-absent (a payload without scripts/ mirrored) is a
 *  graceful no-op with an honest audit note — never a crash. Returns true if it
 *  ran this call. */
export async function pumpIntegrityStressIfDue(): Promise<boolean> {
  const at = new Date().toISOString();
  const todayUtc = at.slice(0, 10);
  try {
    const raw = await fsp.readFile(metricsPath(), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]) as { at?: string };
      if (String(last.at).slice(0, 10) === todayUtc) return false; // already ran today
    }
  } catch {
    /* no metrics log yet → run */
  }
  try {
    await runStress(`v${BUILD_VERSION}-scheduled`, at);
    return true;
  } catch (e) {
    await appendAudit("integrity.stress_skipped", {
      reason: `corpus unavailable at runtime cwd: ${(e as Error).message}`,
    }).catch(() => {});
    return false;
  }
}

export interface RollingMetrics {
  runs: number;
  lastAt: string | null;
  lastCatchRate: number | null;
  lastFalsePositiveRate: number | null;
  lastMissedIds: string[];
  /** Mean catch rate over runs in the trailing 7 days. */
  catchRate7d: number | null;
  trend: Array<{ at: string; catchRate: number; missed: number }>;
  anyMissLastRun: boolean;
}

/** Rolling metrics from the metrics log. `nowMs` lets callers control the clock. */
export async function computeRollingMetrics(nowMs?: number): Promise<RollingMetrics> {
  let lines: Array<Record<string, unknown>> = [];
  try {
    const raw = await fsp.readFile(metricsPath(), "utf8");
    lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return {
      runs: 0, lastAt: null, lastCatchRate: null, lastFalsePositiveRate: null,
      lastMissedIds: [], catchRate7d: null, trend: [], anyMissLastRun: false,
    };
  }
  const last = lines[lines.length - 1] ?? {};
  const now = nowMs ?? (Date.parse(String(last.at ?? "")) || 0);
  const sevenDayAgo = now - 7 * 24 * 3600 * 1000;
  const recent = lines.filter((l) => Date.parse(String(l.at)) >= sevenDayAgo);
  const catchRates = recent.map((l) => Number(l.catchRate)).filter((n) => !Number.isNaN(n));
  return {
    runs: lines.length,
    lastAt: (last.at as string) ?? null,
    lastCatchRate: typeof last.catchRate === "number" ? last.catchRate : null,
    lastFalsePositiveRate: typeof last.falsePositiveRate === "number" ? last.falsePositiveRate : null,
    lastMissedIds: Array.isArray(last.missedIds) ? (last.missedIds as string[]) : [],
    catchRate7d: catchRates.length ? catchRates.reduce((a, b) => a + b, 0) / catchRates.length : null,
    trend: lines.slice(-14).map((l) => ({
      at: String(l.at),
      catchRate: Number(l.catchRate) || 0,
      missed: Number(l.missed) || 0,
    })),
    anyMissLastRun: Array.isArray(last.missedIds) && (last.missedIds as string[]).length > 0,
  };
}
