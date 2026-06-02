// lib/loops/apply.ts
//
// Self-Evolving Loop Suite — all-night doctrine (2026-06-02).
//
// The autonomous apply pipeline. This replaces the old "park it as a pending
// approval" flow. A loop that wants to change a file calls applyWithBackupTest:
//
//   1. governance + boundary gate (rsi-gate) — refuse governance code unless
//      ARGOS_RSI_ALLOW_GOVERNANCE is set; refuse anything outside ARGOS_ROOT.
//   2. BACKUP every target file (no write without a successful backup).
//   3. WRITE the new content.
//   4. TEST — a command (green = exit 0) or an in-process fn (green = true)
//      or none (data writes that have no meaningful test).
//   5. KEEP if green; ROLLBACK from the backup if red.
//   6. LOG the outcome to state/loops/patches/{APPLIED,FAILED}/YYYY-MM-DD/.
//
// Bart proposes, tests, applies, logs. The operator reads the logs in the
// morning. A global kill switch (ARGOS_LOOPS_APPLY=0) disables ALL autonomous
// writes without touching the loops.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { argosRoot } from "../vault/paths";
import { createLoopBackup, rollbackLoopBackup } from "./backup";
import { checkRsiProposal } from "./rsi-gate";

export interface ApplyFile {
  /** Path relative to ARGOS_ROOT (or absolute within it). */
  target: string;
  /** The full new file content (this pipeline does whole-file writes). */
  content: string;
}

export type ApplyTest =
  | { kind: "none" }
  | { kind: "command"; argv: string[]; timeoutMs?: number; shell?: boolean }
  | { kind: "fn"; run: () => Promise<boolean> };

export interface ApplyRequest {
  loopId: string;
  reason: string;
  files: ApplyFile[];
  test: ApplyTest;
}

export interface ApplyResult {
  applied: boolean; // did we attempt the write
  kept: boolean; // passed the test and stayed
  rolledBack: boolean;
  backupId: string | null;
  testPassed: boolean | null;
  reason: string;
  files: string[];
  logPath: string | null;
}

/** Global kill switch. Default ON (the all-night doctrine wants autonomy). */
export function applyEnabled(): boolean {
  const v = (process.env.ARGOS_LOOPS_APPLY ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

function absFor(target: string): string {
  return path.isAbsolute(target) ? target : path.join(argosRoot(), target);
}

async function logOutcome(
  status: "APPLIED" | "FAILED",
  req: ApplyRequest,
  backupId: string | null,
  testPassed: boolean | null
): Promise<string | null> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(argosRoot(), "state", "loops", "patches", status, day);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${req.loopId}-${stamp}.json`);
    const record = {
      at: new Date().toISOString(),
      status,
      loopId: req.loopId,
      reason: req.reason,
      backupId,
      testKind: req.test.kind,
      testPassed,
      files: req.files.map((f) => ({
        target: f.target,
        newBytes: Buffer.byteLength(f.content, "utf8"),
        preview: f.content.slice(0, 400),
      })),
    };
    await fsp.writeFile(file, JSON.stringify(record, null, 2), "utf8");
    return file;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[loops/apply] outcome log failed: ${(e as Error).message}`);
    return null;
  }
}

function runCommandTest(t: { argv: string[]; timeoutMs?: number; shell?: boolean }): boolean {
  if (t.argv.length === 0) return true;
  const r = spawnSync(t.argv[0], t.argv.slice(1), {
    cwd: argosRoot(),
    timeout: t.timeoutMs ?? 120_000,
    shell: t.shell ?? false,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  return r.status === 0;
}

/**
 * Apply one or more whole-file writes behind a backup + test. Never throws.
 * On test failure the files are restored to their pre-write bytes.
 */
export async function applyWithBackupTest(req: ApplyRequest): Promise<ApplyResult> {
  const targets = req.files.map((f) => f.target);
  const fail = (reason: string, extra: Partial<ApplyResult> = {}): ApplyResult => ({
    applied: false,
    kept: false,
    rolledBack: false,
    backupId: null,
    testPassed: null,
    reason,
    files: targets,
    logPath: null,
    ...extra,
  });

  if (!applyEnabled()) return fail("autonomous apply disabled (ARGOS_LOOPS_APPLY=0)");
  if (req.files.length === 0) return fail("no files to apply");

  // 1) governance + boundary gate for EVERY target.
  for (const f of req.files) {
    const gate = checkRsiProposal({ kind: "patch", description: req.reason, target: f.target });
    if (!gate.allowed) return fail(`refused: ${gate.reason}`);
  }

  // 2) BACKUP before any write.
  const backupId = await createLoopBackup(
    req.loopId,
    req.reason,
    req.files.map((f) => absFor(f.target))
  );
  if (!backupId) return fail("backup failed — refusing to write");

  // 3) WRITE.
  try {
    for (const f of req.files) {
      const abs = absFor(f.target);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, f.content, "utf8");
    }
  } catch (e) {
    await rollbackLoopBackup(backupId);
    return fail(`write failed (rolled back): ${(e as Error).message}`, {
      applied: true,
      rolledBack: true,
      backupId,
    });
  }

  // 4) TEST.
  let testPassed = true;
  try {
    if (req.test.kind === "command") testPassed = runCommandTest(req.test);
    else if (req.test.kind === "fn") testPassed = await req.test.run();
    else testPassed = true; // "none"
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[loops/apply] test threw: ${(e as Error).message}`);
    testPassed = false;
  }

  // 5) KEEP or ROLLBACK.
  if (testPassed) {
    const logPath = await logOutcome("APPLIED", req, backupId, true);
    return {
      applied: true,
      kept: true,
      rolledBack: false,
      backupId,
      testPassed: true,
      reason: "applied + test green",
      files: targets,
      logPath,
    };
  }
  const rb = await rollbackLoopBackup(backupId);
  const logPath = await logOutcome("FAILED", req, backupId, false);
  return {
    applied: true,
    kept: false,
    rolledBack: rb.ok,
    backupId,
    testPassed: false,
    reason: `test failed — rolled back (${rb.reason})`,
    files: targets,
    logPath,
  };
}

/** Read applied/rolled-back patch records for the API + morning brief. */
export async function readPatchRecords(
  status: "APPLIED" | "FAILED",
  sinceDays = 7
): Promise<unknown[]> {
  const base = path.join(argosRoot(), "state", "loops", "patches", status);
  const out: unknown[] = [];
  let days: string[] = [];
  try {
    days = (await fsp.readdir(base)).sort().reverse();
  } catch {
    return [];
  }
  const cutoff = Date.now() - sinceDays * 86_400_000;
  for (const day of days) {
    const t = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) continue;
    try {
      const files = await fsp.readdir(path.join(base, day));
      for (const f of files) {
        try {
          const raw = await fsp.readFile(path.join(base, day, f), "utf8");
          out.push(JSON.parse(raw));
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Count applied / rolled-back patches for a given day (default today). */
export async function patchCountsForDay(
  day = new Date().toISOString().slice(0, 10)
): Promise<{ applied: number; rolledBack: number }> {
  const count = async (status: "APPLIED" | "FAILED") => {
    try {
      const dir = path.join(argosRoot(), "state", "loops", "patches", status, day);
      return (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  };
  return { applied: await count("APPLIED"), rolledBack: await count("FAILED") };
}
