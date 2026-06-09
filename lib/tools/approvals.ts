// lib/tools/approvals.ts
//
// Tools Phase (2026-06-02) — pending-approval store for dangerous tools.
//
// A dangerous tool call is registered here and returned to the UI as
// "approval required". The operator APPROVE/DENY round-trips through
// /api/tools/approve, which resolves the pending entry and (on approve) runs
// the tool. A 60-second timer auto-DENIES — the governance default is "no".
//
// In-memory + single Next.js process (same assumption the scheduler/dispatcher
// make). Not durable across restarts by design: a pending approval that
// outlives the chat turn should expire, not resurrect.

import { randomUUID } from "node:crypto";
import type { ToolContext, ToolPlanStep } from "./types";

export const APPROVAL_TIMEOUT_MS = 60_000;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Disclosure {
  /** What the tool will do. */
  description: string;
  /** What could go wrong. */
  risks: string;
  /** Whether the action is reversible. */
  reversible: boolean;
  /** Stage 1 (2026-06-09) — dry-run manifest: the exact steps that will run on
   *  approval (op + path + restore-point per step). Present for file_ops
   *  (single op = one step; batch = N steps); absent for tools without a
   *  disclose() hook. */
  plan?: ToolPlanStep[];
}

export interface PendingApproval {
  approvalId: string;
  toolId: string;
  toolName: string;
  params: Record<string, unknown>;
  ctx: ToolContext;
  disclosure: Disclosure;
  createdAt: number;
  status: ApprovalStatus;
}

const pending = new Map<string, PendingApproval>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function expireIfStale(a: PendingApproval): PendingApproval {
  if (a.status === "pending" && Date.now() - a.createdAt > APPROVAL_TIMEOUT_MS) {
    a.status = "expired";
  }
  return a;
}

export function registerApproval(args: {
  toolId: string;
  toolName: string;
  params: Record<string, unknown>;
  ctx: ToolContext;
  disclosure: Disclosure;
}): PendingApproval {
  const approvalId = randomUUID();
  const entry: PendingApproval = {
    approvalId,
    toolId: args.toolId,
    toolName: args.toolName,
    params: args.params,
    ctx: args.ctx,
    disclosure: args.disclosure,
    createdAt: Date.now(),
    status: "pending",
  };
  pending.set(approvalId, entry);
  const t = setTimeout(() => {
    const e = pending.get(approvalId);
    if (e && e.status === "pending") e.status = "expired";
  }, APPROVAL_TIMEOUT_MS);
  // Don't keep the event loop alive for a pending approval.
  if (typeof (t as { unref?: () => void }).unref === "function") {
    (t as { unref: () => void }).unref();
  }
  timers.set(approvalId, t);
  return entry;
}

export function getApproval(approvalId: string): PendingApproval | null {
  const a = pending.get(approvalId);
  if (!a) return null;
  return expireIfStale(a);
}

/** Resolve a pending approval. Returns the (possibly already-resolved/expired)
 *  entry, or null if unknown. The caller runs the tool only when the returned
 *  status === "approved". */
export function decideApproval(
  approvalId: string,
  decision: "approve" | "deny"
): PendingApproval | null {
  const a = pending.get(approvalId);
  if (!a) return null;
  expireIfStale(a);
  if (a.status === "pending") {
    a.status = decision === "approve" ? "approved" : "denied";
    const t = timers.get(approvalId);
    if (t) clearTimeout(t);
    timers.delete(approvalId);
  }
  return a;
}

/** Drop a resolved approval from the store (post-run cleanup). */
export function clearApproval(approvalId: string): void {
  pending.delete(approvalId);
  const t = timers.get(approvalId);
  if (t) clearTimeout(t);
  timers.delete(approvalId);
}
