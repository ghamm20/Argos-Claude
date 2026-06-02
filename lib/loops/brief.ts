// lib/loops/brief.ts
//
// Self-Evolving Loop Suite — the morning-brief addendum. Summarizes what the
// loops did overnight so the operator reads it with their coffee: loops fired,
// patches applied + auto-rolled-back, benchmark delta, active-learning
// questions, critical red-team findings, and RSI proposals.

import { readAllTraces } from "./trace-store";
import { patchCountsForDay, readPatchRecords } from "./apply";
import { pendingQuestions } from "./questions";
import { readTraces } from "./trace-store";

export async function loopsBriefSection(sinceMs: number): Promise<string> {
  try {
    const all = await readAllTraces(300);
    const recent = all.filter((t) => {
      const at = Date.parse(t.at);
      return Number.isFinite(at) && at >= sinceMs;
    });
    if (recent.length === 0 && (await pendingQuestions()).length === 0) {
      return "## Self-Evolving Loops\n\nNo loops fired since the last brief.";
    }

    // Loops fired (by id).
    const byLoop: Record<string, number> = {};
    for (const t of recent) byLoop[t.loopId] = (byLoop[t.loopId] ?? 0) + 1;

    const patches = await patchCountsForDay();
    const appliedRecs = (await readPatchRecords("APPLIED", 1)) as Array<{ loopId?: string; reason?: string }>;
    const rolledRecs = (await readPatchRecords("FAILED", 1)) as Array<{ loopId?: string; reason?: string }>;

    // Benchmark delta from the last two benchmark traces.
    const bench = await readTraces("benchmark", 2);
    const curB = bench[0]?.result?.benchmarkAfter ?? null;
    const prevB = bench[1]?.result?.benchmarkAfter ?? bench[0]?.result?.benchmarkBefore ?? null;

    // Critical red-team findings.
    const redCrit = recent.filter(
      (t) => t.loopId === "red_blue_team" && (t.result.data as { critical?: boolean } | null)?.critical
    );
    // RSI proposals + applies.
    const rsi = recent.filter((t) => t.loopId === "rsi_propose" || t.loopId === "rsi_apply");
    const halted = recent.filter((t) => t.outcome === "halted");
    const questions = await pendingQuestions();

    const lines: string[] = ["## Self-Evolving Loops", ""];
    lines.push(`- **Loops fired:** ${recent.length} run(s) — ${Object.entries(byLoop).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`);
    lines.push(`- **Patches:** ${patches.applied} applied, ${patches.rolledBack} auto-rolled-back`);
    for (const p of appliedRecs.slice(0, 5)) lines.push(`  - ✅ ${p.loopId}: ${p.reason}`);
    for (const p of rolledRecs.slice(0, 5)) lines.push(`  - ↩️ ${p.loopId} rolled back: ${p.reason}`);
    if (curB !== null) {
      const delta = prevB !== null ? curB - prevB : null;
      lines.push(`- **Benchmark:** ${(curB * 100).toFixed(0)}%${delta !== null ? ` (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)} pts)` : ""}`);
    }
    if (halted.length) lines.push(`- **⛔ Halted by the gate (gaming):** ${halted.length}`);
    if (redCrit.length) lines.push(`- **🛡 Critical red-team findings:** ${redCrit.length} — review state/loops/red-blue/`);
    if (rsi.length) lines.push(`- **RSI activity:** ${rsi.length} proposal/apply run(s)`);
    if (questions.length) {
      lines.push(`- **❓ Questions awaiting your answer:** ${questions.length}`);
      for (const q of questions.slice(0, 3)) lines.push(`  - ${q.question}`);
    }
    return lines.join("\n");
  } catch (e) {
    return `## Self-Evolving Loops\n\n(brief section unavailable: ${(e as Error).message})`;
  }
}
