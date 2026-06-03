// lib/integrity-log.ts
//
// Doctrine violation log (v2.3.8) — append-only record of every detected
// integrity violation (a turn that claimed tool execution that did not occur),
// at ARGOS_ROOT/state/integrity-violations.jsonl. Surfaced on the HUD as the
// "INTEGRITY VIOLATIONS: N" counter. Append-only, never overwritten; a violation
// is forensic evidence, not something to quietly clear.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";

export type IntegrityViolationType = "fabrication" | "misrepresentation";

export interface IntegrityViolation {
  at: string; // ISO timestamp
  type: IntegrityViolationType; // v2.3.9 — fabrication (no tool) vs misrepresentation (negative result softened)
  persona: string | null;
  patterns: string[]; // the claim phrases that triggered
  missingTool: string | null; // the tool falsely claimed, if identifiable
  content: string; // the offending assistant message (truncated)
}

export function integrityLogPath(): string {
  return path.join(argosRoot(), "state", "integrity-violations.jsonl");
}

/** Append one violation. Best-effort — never throws (logging failure must not
 *  break the chat stream). */
export async function appendIntegrityViolation(v: {
  type?: IntegrityViolationType;
  persona: string | null;
  patterns: string[];
  missingTool: string | null;
  content: string;
}): Promise<void> {
  try {
    const entry: IntegrityViolation = {
      at: new Date().toISOString(),
      type: v.type ?? "fabrication",
      persona: v.persona,
      patterns: v.patterns,
      missingTool: v.missingTool,
      content: v.content.slice(0, 4000),
    };
    const p = integrityLogPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[integrity-log] append failed (non-fatal): ${(e as Error).message}`);
  }
}

/** Total number of recorded integrity violations (HUD counter). */
export async function integrityViolationCount(): Promise<number> {
  try {
    const raw = await fsp.readFile(integrityLogPath(), "utf8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** The most recent N violations (forensic review / API). */
export async function readIntegrityViolations(limit = 50): Promise<IntegrityViolation[]> {
  try {
    const raw = await fsp.readFile(integrityLogPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const out: IntegrityViolation[] = [];
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l) as IntegrityViolation); } catch { /* skip */ }
    }
    return out.reverse();
  } catch {
    return [];
  }
}
