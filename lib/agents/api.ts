// lib/agents/api.ts
//
// Integration helpers between the existing chat / tools route layer
// and the multi-agent orchestrator.
//
// Boundary rules:
//  - All multi-agent state lives in lib/agents/orchestrator.ts.
//  - This file is the ONLY place that imports the orchestrator from
//    the Next.js route layer, preventing circular deps.
//  - If the orchestrator is disabled or fails to enqueue, the
//    callers fall back to the current synchronous execution path.
//    Chat must NEVER break because the orchestrator is unreachable.

import { getOrchestrator } from "@/lib/agents/orchestrator";
import type { WorkItem, AgentId } from "@/lib/agents/schemas";

let orchPromise: Promise<ReturnType<typeof getOrchestrator>> | null = null;

async function orch() {
  if (!orchPromise) {
    orchPromise = Promise.resolve(getOrchestrator());
  }
  return orchPromise;
}

export async function isOrchestratorEnabled(): Promise<boolean> {
  // The orchestrator is the default runtime now. A settings toggle can
  // disable it later, but that schema change is pending.
  try {
    return true;
  } catch {
    return false;
  }
}

export async function tryEnqueue(
  input: Partial<WorkItem> & { kind: WorkItem["kind"]; payload: WorkItem["payload"]; priority?: WorkItem["priority"] }
): Promise<WorkItem | null> {
  if (!(await isOrchestratorEnabled())) return null;
  try {
    const instance = await orch();
    const generatedId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const item: WorkItem = {
      id: input.id ?? generatedId,
      kind: input.kind,
      priority: input.priority ?? "normal",
      label: input.label,
      personaId: input.personaId,
      toolCall: input.toolCall,
      research: input.research,
      payload: input.payload,
      requestContext: input.requestContext,
      suggestedAgent: input.personaId ? (input.personaId as AgentId) : undefined,
      maxRetries: input.kind === "tool.execute" ? 1 : 2,
      deadlineAt: input.deadlineAt,
    };
    return instance.enqueue(item);
  } catch {
    return null;
  }
}

export async function waitOutcomeSafely(
  workItemId: string,
  timeoutMs = 120_000
): Promise<{ status: string; result?: unknown; error?: unknown } | null> {
  if (!(await isOrchestratorEnabled())) return null;
  try {
    const instance = await orch();
    const outcome = await Promise.race([
      instance.waitOutcome(workItemId).then((o) => ({ ok: true as const, outcome: o })),
      new Promise<{ ok: false }>((resolve) =>
        setTimeout(() => resolve({ ok: false }), timeoutMs)
      ),
    ]);
    if (!outcome.ok) return { status: "timeout" };
    const o = outcome.outcome;
    if (o.status === "completed") return { status: "completed", result: o.result };
    if (o.status === "failed") return { status: "failed", error: o.error };
    return { status: "requeued" };
  } catch {
    return null;
  }
}
