// lib/tools/types.ts
//
// Tools Phase (2026-06-02) — shared types for Bartimaeus's tool suite.
//
// Governance is encoded in the ToolDefinition flags:
//   - requiresApproval  → operator must confirm before execution (disclose+wait)
//   - requiresRestore   → a restore point is created BEFORE execution
//   - dangerous         → writes/deletes/sends/executes/touches external systems
//
// Every tool's execute() returns a ToolResult and NEVER throws — failures
// come back as { ok:false, error }. The executor enforces governance; tools
// just do their job.

export type ToolCategory = "web" | "document" | "comms" | "security" | "system";

export interface ToolContext {
  /** Chat session id (for audit correlation), if known. */
  sessionId?: string | null;
  /** Persona that requested the tool (usually "bartimaeus"). */
  personaId?: string;
  /** Model id for tools that call an LLM (T13 contract, T14 threat). */
  model?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  toolId: string;
  /** Short, human-readable one-liner for the chat result card / audit. */
  summary: string;
  /** Structured result payload (tool-specific shape). */
  data?: unknown;
  /** Present when ok === false. */
  error?: string;
  /** Optional source links (web tools, OSINT). */
  sources?: string[];
  /** Set when a restore point was created before this execution. */
  restorePointId?: string;
}

export type ToolExecute = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>;

/** Governance flag — static, or computed per-call from the params. T15
 *  (file-ops) needs approval only for write/move/delete; T16 (shell) always.
 *  A function lets the SAME tool govern itself per operation. */
export type GovFlag =
  | boolean
  | ((params: Record<string, unknown>) => boolean);

export function resolveGov(
  flag: GovFlag,
  params: Record<string, unknown>
): boolean {
  try {
    return typeof flag === "function" ? flag(params) : flag;
  } catch {
    // Fail safe: if the predicate throws, demand approval / restore.
    return true;
  }
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  /** Disclose risks + wait for operator confirmation before executing. */
  requiresApproval: GovFlag;
  /** Create a restore point BEFORE executing (irreversible actions). */
  requiresRestore: GovFlag;
  /** Writes / deletes / sends / executes / touches external systems. */
  dangerous: boolean;
  /** Can the action be undone? Disclosed to the operator before approval.
   *  Sends (Pushover/SMS) and shell execution are NOT reversible. */
  reversible: boolean;
  /** Plain-language risk disclosure shown in the approval dialog. */
  risks?: string;
  /** Pre-approval gate. Runs BEFORE any approval prompt — used by T16 to
   *  HARD-deny non-whitelisted commands and T15 to enforce the ARGOS_ROOT
   *  boundary. Return { ok:false, error } to reject immediately. */
  validate?: (params: Record<string, unknown>) => { ok: boolean; error?: string };
  /** For restore-required tools: the files to snapshot BEFORE executing,
   *  derived from the call params. */
  restorePaths?: (params: Record<string, unknown>) => string[];
  execute: ToolExecute;
}

/** Append-only audit record written to state/tool-audit.jsonl. */
export interface ToolAuditEntry {
  at: string; // ISO timestamp
  toolId: string;
  approved: boolean | null; // null = no approval needed (safe tool)
  ok: boolean;
  summary: string;
  error: string | null;
  restorePointId: string | null;
  sessionId: string | null;
  persona: string | null;
  durationMs: number;
  // v2.3.8: distinguishes a real execution from a PARSE FAILURE — a tool-call
  // the model emitted that the parser could not execute. Logged so a tool-call
  // attempt is never silently lost. Optional for back-compat (older entries are
  // executions). `rawText` carries what the model actually emitted.
  event?: "execution" | "parse_failed";
  rawText?: string | null;
}

/** A small, consistent helper for tool authors. */
export function toolOk(
  toolId: string,
  summary: string,
  extra: Partial<ToolResult> = {}
): ToolResult {
  return { ok: true, toolId, summary, ...extra };
}
export function toolErr(
  toolId: string,
  error: string,
  extra: Partial<ToolResult> = {}
): ToolResult {
  return { ok: false, toolId, summary: `failed: ${error}`, error, ...extra };
}
