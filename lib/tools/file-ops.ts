// lib/tools/file-ops.ts — T15 File System Operations.
//
// Operations: read | write | move | list | delete | mkdir | copy | batch.
//   - read/list                         → safe (no approval)
//   - write/move/delete/mkdir/copy       → operator approval (write tier)
//   - delete                             → restore point taken first
//   - batch                              → one approval for the whole manifest;
//                                          gated if ANY sub-op is write-tier;
//                                          restore point if ANY sub-op deletes.
//
// Nothing outside ARGOS_ROOT is ever touched — the boundary is enforced by
// resolveWithinRoot (symlink-safe since Gate 2) in validate() BEFORE any
// approval, and again at execute time. (Stage 1 agentic, 2026-06-09.)

import { promises as fsp } from "node:fs";
import path from "node:path";
import { toolOk, toolErr, type ToolExecute, type ToolDisclosure, type ToolPlanStep, type ToolContext } from "./types";
import { resolveWithinRoot } from "./fs-guard";
import { appendAudit } from "../audit";
import { appendToolAudit } from "./audit";

export const ID = "file_ops";

// Single-step operations (everything except the batch wrapper itself).
const SINGLE_OPS = new Set(["read", "write", "move", "list", "delete", "mkdir", "copy"]);
// GOVERNANCE TIERS (Phase 1 locked spec):
//   read / list        → low friction (no gate beyond the operator session).
//   write/copy/move/mkdir → SESSION-GATED: allowed within a valid operator
//                        session (the chat path runs file_ops only when
//                        isOperator) and AUDITED — but NOT routed to the
//                        approval queue. This lets a persona autonomously save
//                        a file in-session.
//   delete             → APPROVAL QUEUE ONLY, never direct; a restore point is
//                        taken first.
// WRITE_OPS = the session-gated + audited write tier (used for validation +
// batch restore math). APPROVAL_OPS = the subset that ADDITIONALLY needs the
// operator approval queue (delete only).
const WRITE_OPS = new Set(["write", "move", "delete", "mkdir", "copy"]);
const APPROVAL_OPS = new Set(["delete"]);
// Operations needing a destination path.
const DEST_OPS = new Set(["move", "copy"]);
// Hard cap on a single batch so one approval can't smuggle an unbounded plan.
const MAX_BATCH = 25;

// Belt-and-suspenders (2026-06-09): the tool-call harness showed the dominant
// malform across every model was `"action"` in place of `"operation"`. The
// prompt now specifies the key, but accept `action` as an alias so an
// otherwise-perfect call still runs. Every alias acceptance is audited
// (kind "tool.param_alias") so usage stays measurable. The WeakSet de-dupes
// per object — normOp() is called many times on the same params object across
// validate/approval/restore/execute (and once per sub-op).
const aliasAudited = new WeakSet<object>();

/** Resolve the operation name from any op-shaped object, accepting the
 *  `action` alias (audited once per object). */
function normOp(o: Record<string, unknown>): string {
  const primary = o.operation ?? o.op;
  if (primary == null && o.action != null) {
    if (!aliasAudited.has(o)) {
      aliasAudited.add(o);
      void appendAudit("tool.param_alias", {
        toolId: ID,
        alias: "action",
        value: String(o.action),
      }).catch(() => {
        /* audit is the receipt, never the gate */
      });
    }
    return String(o.action).toLowerCase();
  }
  return String(primary ?? "").toLowerCase();
}

function op(params: Record<string, unknown>): string {
  return normOp(params);
}

/** The ops array for a batch, or null if absent/empty/not an array. */
function batchOps(params: Record<string, unknown>): Record<string, unknown>[] | null {
  const ops = params.ops;
  if (!Array.isArray(ops) || ops.length === 0) return null;
  return ops as Record<string, unknown>[];
}

/** Validate ONE single-step op object: known op + bounded path(s). */
function validateSingle(o: Record<string, unknown>): { ok: boolean; error?: string } {
  const operation = normOp(o);
  if (!SINGLE_OPS.has(operation)) {
    return { ok: false, error: `unknown operation "${operation}" (read|write|move|list|delete|mkdir|copy)` };
  }
  const p = String(o.path ?? "").trim();
  if (!p) return { ok: false, error: "path is required" };
  const r = resolveWithinRoot(p);
  if (!r.ok) return { ok: false, error: r.error };
  if (DEST_OPS.has(operation)) {
    const dest = String(o.dest ?? "").trim();
    if (!dest) return { ok: false, error: `${operation} requires dest` };
    const rd = resolveWithinRoot(dest);
    if (!rd.ok) return { ok: false, error: rd.error };
  }
  return { ok: true };
}

/** Pre-approval gate: valid op(s) + every referenced path inside the boundary. */
export function validate(params: Record<string, unknown>): { ok: boolean; error?: string } {
  const operation = op(params);
  if (operation === "batch") {
    const ops = batchOps(params);
    if (!ops) return { ok: false, error: "batch requires a non-empty ops array" };
    if (ops.length > MAX_BATCH) {
      return { ok: false, error: `batch too large (${ops.length} ops; max ${MAX_BATCH})` };
    }
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (!o || typeof o !== "object") return { ok: false, error: `batch op ${i} is not an object` };
      if (normOp(o) === "batch") return { ok: false, error: `batch op ${i}: nested batch not allowed` };
      const v = validateSingle(o);
      if (!v.ok) return { ok: false, error: `batch op ${i}: ${v.error}` };
    }
    return { ok: true };
  }
  return validateSingle(params);
}

export function requiresApproval(params: Record<string, unknown>): boolean {
  const operation = op(params);
  if (operation === "batch") {
    // A batch needs approval iff it CONTAINS a delete (a chain cannot launder a
    // delete past the queue — every delete, even inside a batch, is gated).
    return (batchOps(params) ?? []).some((o) => APPROVAL_OPS.has(normOp(o)));
  }
  return APPROVAL_OPS.has(operation);
}

export function requiresRestore(params: Record<string, unknown>): boolean {
  const operation = op(params);
  if (operation === "batch") {
    return (batchOps(params) ?? []).some((o) => normOp(o) === "delete");
  }
  return operation === "delete";
}

/** Paths to snapshot before a destructive op: deletes (the path), and the
 *  destinations of move/copy (which may overwrite). Unioned across a batch. */
function restorePathsForSingle(o: Record<string, unknown>): string[] {
  const operation = normOp(o);
  const out: string[] = [];
  const add = (raw: unknown) => {
    const s = String(raw ?? "").trim();
    if (!s) return;
    const r = resolveWithinRoot(s);
    if (r.ok) out.push(r.abs);
  };
  if (operation === "delete") add(o.path);
  if (operation === "move") {
    add(o.path);
    add(o.dest);
  }
  if (operation === "copy") add(o.dest);
  return out;
}

export function restorePaths(params: Record<string, unknown>): string[] {
  const operation = op(params);
  if (operation === "batch") {
    return (batchOps(params) ?? []).flatMap(restorePathsForSingle);
  }
  return restorePathsForSingle(params);
}

/** Build the dry-run manifest shown on the approval card. */
function planStep(o: Record<string, unknown>): ToolPlanStep {
  const operation = normOp(o);
  const dest = String(o.dest ?? "").trim();
  return {
    op: operation,
    path: String(o.path ?? "").trim(),
    dest: dest || undefined,
    restorePoint: operation === "delete",
  };
}

export function disclose(params: Record<string, unknown>): ToolDisclosure {
  const operation = op(params);
  const steps =
    operation === "batch"
      ? (batchOps(params) ?? []).map(planStep)
      : [planStep(params)];
  const writeSteps = steps.filter((s) => WRITE_OPS.has(s.op));
  const verb = operation === "batch" ? `batch of ${steps.length} file operations` : `${operation} operation`;
  return {
    description: `File System Operations — ${verb} inside ARGOS_ROOT.`,
    risks:
      writeSteps.some((s) => s.op === "delete")
        ? "Includes a delete — a restore point is created first; review the manifest."
        : "Writes/moves/copies/creates files inside ARGOS_ROOT only.",
    reversible: true,
    plan: steps,
  };
}

// ---- execution ----

/** Run one single-step op and return its result. NEVER throws. */
async function runSingle(o: Record<string, unknown>): Promise<{ ok: boolean; summary: string; error?: string; data?: unknown }> {
  const operation = normOp(o);
  const v = validateSingle(o);
  if (!v.ok) return { ok: false, summary: `failed: ${v.error}`, error: v.error };
  const abs = resolveWithinRoot(String(o.path)).abs;
  const relPath = String(o.path ?? "").trim();
  try {
    if (operation === "list") {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return {
        ok: true,
        summary: `${entries.length} entries in ${relPath}`,
        data: { path: abs, entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })) },
      };
    }
    if (operation === "read") {
      const buf = await fsp.readFile(abs, "utf8");
      return {
        ok: true,
        summary: `read ${buf.length} chars from ${relPath}`,
        data: { path: abs, content: buf.slice(0, 20_000), truncated: buf.length > 20_000 },
      };
    }
    if (operation === "mkdir") {
      await fsp.mkdir(abs, { recursive: true });
      return { ok: true, summary: `created directory ${relPath}`, data: { path: abs } };
    }
    if (operation === "write") {
      const content = String(o.content ?? "");
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
      return { ok: true, summary: `wrote ${Buffer.byteLength(content)} bytes to ${relPath}`, data: { path: abs, bytes: Buffer.byteLength(content) } };
    }
    if (operation === "move") {
      const dest = resolveWithinRoot(String(o.dest)).abs;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(abs, dest);
      return { ok: true, summary: `moved ${relPath} -> ${String(o.dest)}`, data: { from: abs, to: dest } };
    }
    if (operation === "copy") {
      const dest = resolveWithinRoot(String(o.dest)).abs;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      // recursive handles both files and directory trees; force overwrites.
      await fsp.cp(abs, dest, { recursive: true, force: true });
      return { ok: true, summary: `copied ${relPath} -> ${String(o.dest)}`, data: { from: abs, to: dest } };
    }
    if (operation === "delete") {
      await fsp.rm(abs, { recursive: true, force: true });
      return { ok: true, summary: `deleted ${relPath} (restore point created)`, data: { path: abs } };
    }
    return { ok: false, summary: `failed: unsupported operation: ${operation}`, error: `unsupported operation: ${operation}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, summary: `${operation} failed: ${msg}`, error: msg };
  }
}

export const execute: ToolExecute = async (params, ctx?: ToolContext) => {
  const operation = op(params);
  const v = validate(params);
  if (!v.ok) return toolErr(ID, v.error ?? "invalid file operation");

  if (operation === "batch") {
    const ops = batchOps(params) ?? [];
    const results: Array<{ index: number; op: string; ok: boolean; summary: string; error?: string }> = [];
    let okCount = 0;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      const r = await runSingle(o);
      if (r.ok) okCount++;
      results.push({ index: i, op: normOp(o), ok: r.ok, summary: r.summary, error: r.error });
      // One audit entry PER op (Stage 1 directive) — distinct from the
      // executor's single batch-level entry. Best-effort; never blocks.
      await appendToolAudit({
        at: new Date().toISOString(),
        toolId: ID,
        approved: true, // batch only reaches execute after operator approval
        ok: r.ok,
        summary: `[batch ${i + 1}/${ops.length}] ${r.summary}`,
        error: r.error ?? null,
        restorePointId: null,
        sessionId: ctx?.sessionId ?? null,
        persona: ctx?.personaId ?? null,
        durationMs: 0,
      });
    }
    const allOk = okCount === ops.length;
    return {
      ok: allOk,
      toolId: ID,
      summary: `batch: ${okCount}/${ops.length} operations succeeded`,
      data: { results },
      ...(allOk ? {} : { error: `${ops.length - okCount} of ${ops.length} batch operations failed` }),
    };
  }

  const r = await runSingle(params);
  return r.ok
    ? toolOk(ID, r.summary, { data: r.data })
    : toolErr(ID, r.error ?? r.summary);
};
