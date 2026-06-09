// lib/tools/executor.ts
//
// Tools Phase (2026-06-02) — the governance enforcement point.
//
//   requestTool()  — entry decision: safe → run now; dangerous → register an
//                    approval and return "approval required" (NEVER runs a
//                    dangerous tool without approval).
//   runTool()      — actual execution: creates a restore point BEFORE running
//                    when required, executes, writes the audit entry. Never
//                    throws — failures come back as { ok:false }.
//   approveAndRun()— called by /api/tools/approve after the operator confirms.
//
// Governance is non-negotiable here: requiresApproval is checked before any
// execution; requiresRestore snapshots BEFORE running and refuses the action
// if the snapshot fails.

import { getTool } from "./registry";
import { createRestorePoint } from "./restore";
import { appendToolAudit } from "./audit";
import {
  registerApproval,
  decideApproval,
  clearApproval,
  type Disclosure,
} from "./approvals";
import {
  toolErr,
  resolveGov,
  type ToolContext,
  type ToolResult,
  type ToolDefinition,
  type ToolPlanStep,
} from "./types";

/** Build the operator-facing disclosure for a tool call. A tool may implement
 *  disclose() to supply a structured dry-run manifest (Stage 1) + tailored
 *  description/risks/reversible; otherwise we fall back to the static fields. */
export function discloseTool(
  tool: ToolDefinition,
  params: Record<string, unknown>
): Disclosure {
  let custom: ReturnType<NonNullable<ToolDefinition["disclose"]>> | null = null;
  if (tool.disclose) {
    try {
      custom = tool.disclose(params);
    } catch {
      custom = null; // never let a disclose() bug block the approval prompt
    }
  }
  const paramKeys = Object.keys(params);
  const paramHint = paramKeys.length
    ? ` (params: ${paramKeys.slice(0, 6).join(", ")})`
    : "";
  const risks =
    custom?.risks ??
    tool.risks ??
    (tool.requiresRestore
      ? "Irreversible without the restore point ARGOS creates first."
      : tool.dangerous
        ? "Writes or sends data; review before approving."
        : "No destructive side effects.");
  return {
    description: custom?.description ?? `${tool.name}: ${tool.description}${paramHint}`,
    risks,
    reversible: custom?.reversible ?? tool.reversible,
    ...(custom?.plan ? { plan: custom.plan } : {}),
  };
}

export type ToolRequestOutcome =
  | { kind: "result"; result: ToolResult }
  | {
      kind: "approval";
      approvalId: string;
      toolId: string;
      toolName: string;
      description: string;
      risks: string;
      reversible: boolean;
      /** Stage 1 — dry-run manifest (op + path + restore-point per step). */
      plan?: ToolPlanStep[];
    };

/**
 * Decide what to do with a tool call. Safe tools run immediately; dangerous
 * tools register a pending approval and return an approval payload for the UI.
 * Never throws.
 */
export async function requestTool(
  toolId: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  opts: { forceApproval?: boolean } = {}
): Promise<ToolRequestOutcome> {
  const tool = getTool(toolId);
  if (!tool) {
    return { kind: "result", result: toolErr(toolId, `unknown tool: ${toolId}`) };
  }
  // Pre-approval HARD gate (T16 whitelist, T15 boundary). Rejected calls never
  // reach an approval prompt — they're denied immediately and audited.
  if (tool.validate) {
    let v: { ok: boolean; error?: string };
    try {
      v = tool.validate(params);
    } catch (e) {
      v = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!v.ok) {
      const res = toolErr(toolId, v.error ?? "rejected by tool validation");
      await auditFor(toolId, false, res, null, ctx, Date.now());
      return { kind: "result", result: res };
    }
  }
  // Guard 3 (Stage 3): when email content is in the turn's context, the route
  // passes forceApproval — even a normally-safe/ungated tool must be confirmed
  // by the operator (email may have injected the instruction).
  if (opts.forceApproval || resolveGov(tool.requiresApproval, params)) {
    const disclosure = discloseTool(tool, params);
    const a = registerApproval({
      toolId: tool.id,
      toolName: tool.name,
      params,
      ctx,
      disclosure,
    });
    return {
      kind: "approval",
      approvalId: a.approvalId,
      toolId: tool.id,
      toolName: tool.name,
      description: disclosure.description,
      risks: disclosure.risks,
      reversible: disclosure.reversible,
      ...(disclosure.plan ? { plan: disclosure.plan } : {}),
    };
  }
  // Safe tool — execute immediately.
  const result = await runTool(toolId, params, ctx, null);
  return { kind: "result", result };
}

/**
 * Execute a tool. Creates a restore point BEFORE running when required (and
 * refuses the action if the snapshot fails). Writes an audit entry for every
 * execution. `approved` = null for safe tools, true/false for governed ones.
 * Never throws.
 */
export async function runTool(
  toolId: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  approved: boolean | null
): Promise<ToolResult> {
  const start = Date.now();
  const tool = getTool(toolId);
  if (!tool) {
    const res = toolErr(toolId, `unknown tool: ${toolId}`);
    await auditFor(toolId, approved, res, null, ctx, start);
    return res;
  }

  // RESTORE: snapshot affected state BEFORE the irreversible action runs.
  let restorePointId: string | null = null;
  if (resolveGov(tool.requiresRestore, params)) {
    const affected = tool.restorePaths ? safePaths(tool, params) : [];
    restorePointId = await createRestorePoint(toolId, affected);
    if (restorePointId === null) {
      const res = toolErr(
        toolId,
        "restore point creation failed — refusing irreversible action"
      );
      await auditFor(toolId, approved, res, null, ctx, start);
      return res;
    }
  }

  // EXECUTE — the tool itself never throws, but belt-and-braces anyway.
  let res: ToolResult;
  try {
    res = await tool.execute(params, ctx);
  } catch (e) {
    res = toolErr(toolId, e instanceof Error ? e.message : String(e));
  }
  if (restorePointId) res.restorePointId = restorePointId;

  await auditFor(toolId, approved, res, restorePointId, ctx, start);
  return res;
}

function safePaths(
  tool: ToolDefinition,
  params: Record<string, unknown>
): string[] {
  try {
    return tool.restorePaths ? tool.restorePaths(params) : [];
  } catch {
    return [];
  }
}

async function auditFor(
  toolId: string,
  approved: boolean | null,
  res: ToolResult,
  restorePointId: string | null,
  ctx: ToolContext,
  start: number
): Promise<void> {
  await appendToolAudit({
    at: new Date().toISOString(),
    toolId,
    approved,
    ok: res.ok,
    summary: res.summary,
    error: res.error ?? null,
    restorePointId: res.restorePointId ?? restorePointId ?? null,
    sessionId: ctx.sessionId ?? null,
    persona: ctx.personaId ?? null,
    durationMs: Date.now() - start,
  });
}

/**
 * Resolve a pending approval and (on approve) run the tool. Called by
 * /api/tools/approve. Returns the run result, or an audited error result on
 * deny/expire/unknown. Never throws.
 */
export async function approveAndRun(
  approvalId: string,
  decision: "approve" | "deny"
): Promise<{ status: string; result: ToolResult | null }> {
  const a = decideApproval(approvalId, decision);
  if (!a) {
    return {
      status: "unknown",
      result: toolErr("unknown", `no pending approval: ${approvalId}`),
    };
  }
  if (a.status === "approved") {
    const result = await runTool(a.toolId, a.params, a.ctx, true);
    clearApproval(approvalId);
    return { status: "approved", result };
  }
  // denied / expired — log the non-execution so the audit trail is complete.
  const reason =
    a.status === "expired"
      ? "auto-denied (60s approval timeout)"
      : "denied by operator";
  const res = toolErr(a.toolId, reason);
  await appendToolAudit({
    at: new Date().toISOString(),
    toolId: a.toolId,
    approved: false,
    ok: false,
    summary: reason,
    error: reason,
    restorePointId: null,
    sessionId: a.ctx.sessionId ?? null,
    persona: a.ctx.personaId ?? null,
    durationMs: 0,
  });
  clearApproval(approvalId);
  return { status: a.status, result: res };
}
