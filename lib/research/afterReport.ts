// lib/research/afterReport.ts
//
// Phase 11 — post-report hook. Called after every successful
// runResearch() invocation (chat-triggered OR scheduler-triggered)
// to:
//
//   1. Write the report to persona-scoped Phase 9 memory when
//      quality is SUFFICIENT
//   2. Fire a Pushover alert when criteria are met
//
// Both steps are fire-and-forget — failures are logged but never
// surfaced back into the chat or scheduler path. Exported as a
// single function so chat-route + scheduler share one entrypoint.

import type { ResearchReport } from "./types";
import type { MemoryPersonaScope } from "../memory/schema";
import { writeResearchMemory } from "./memory";
import { sendAlert } from "./alerts";

export interface AfterReportResult {
  memoryWritten: boolean;
  memoryReason: string;
  alertSent: boolean;
  alertReason: string;
}

export async function afterReport(
  report: ResearchReport,
  personaId: MemoryPersonaScope
): Promise<AfterReportResult> {
  // Run both side-effects in parallel — neither blocks the other,
  // and each catches its own errors.
  const [memRes, alertRes] = await Promise.all([
    writeResearchMemory(report, personaId).catch((e) => ({
      ok: false,
      reason: `memory threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    sendAlert(report).catch((e) => ({
      sent: false,
      reason: `alert threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
  ]);
  return {
    memoryWritten: memRes.ok,
    memoryReason: memRes.reason,
    alertSent: alertRes.sent,
    alertReason: alertRes.reason,
  };
}
