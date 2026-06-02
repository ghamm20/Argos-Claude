// lib/tools/file-ops.ts — T15 File System Operations (write/move/delete:
// approval; delete: restore). HARD ARGOS_ROOT boundary.
//
// Operations: read | write | move | list | delete. Nothing outside
// ARGOS_ROOT is ever touched — the boundary is enforced in validate() before
// any approval, and again at execute time.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { toolOk, toolErr, type ToolExecute } from "./types";
import { resolveWithinRoot } from "./fs-guard";

export const ID = "file_ops";

const WRITE_OPS = new Set(["write", "move", "delete"]);
const ALL_OPS = new Set(["read", "write", "move", "list", "delete"]);

function op(params: Record<string, unknown>): string {
  return String(params.operation ?? params.op ?? "").toLowerCase();
}

/** Pre-approval gate: valid op + every referenced path inside the boundary. */
export function validate(params: Record<string, unknown>): { ok: boolean; error?: string } {
  const o = op(params);
  if (!ALL_OPS.has(o)) {
    return { ok: false, error: `unknown operation "${o}" (read|write|move|list|delete)` };
  }
  const p = String(params.path ?? "").trim();
  if (!p) return { ok: false, error: "path is required" };
  const r = resolveWithinRoot(p);
  if (!r.ok) return { ok: false, error: r.error };
  if (o === "move") {
    const dest = String(params.dest ?? "").trim();
    if (!dest) return { ok: false, error: "move requires dest" };
    const rd = resolveWithinRoot(dest);
    if (!rd.ok) return { ok: false, error: rd.error };
  }
  return { ok: true };
}

export function requiresApproval(params: Record<string, unknown>): boolean {
  return WRITE_OPS.has(op(params));
}
export function requiresRestore(params: Record<string, unknown>): boolean {
  return op(params) === "delete";
}
export function restorePaths(params: Record<string, unknown>): string[] {
  const o = op(params);
  const paths: string[] = [];
  const p = String(params.path ?? "").trim();
  if (p) {
    const r = resolveWithinRoot(p);
    if (r.ok) paths.push(r.abs);
  }
  if (o === "move") {
    const dest = String(params.dest ?? "").trim();
    const rd = resolveWithinRoot(dest);
    if (rd.ok) paths.push(rd.abs);
  }
  return paths;
}

export const execute: ToolExecute = async (params) => {
  const o = op(params);
  const v = validate(params);
  if (!v.ok) return toolErr(ID, v.error ?? "invalid file operation");
  const abs = resolveWithinRoot(String(params.path)).abs;

  try {
    if (o === "list") {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return toolOk(ID, `${entries.length} entries in ${params.path}`, {
        data: {
          path: abs,
          entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })),
        },
      });
    }
    if (o === "read") {
      const buf = await fsp.readFile(abs, "utf8");
      return toolOk(ID, `read ${buf.length} chars from ${params.path}`, {
        data: { path: abs, content: buf.slice(0, 20_000), truncated: buf.length > 20_000 },
      });
    }
    if (o === "write") {
      const content = String(params.content ?? "");
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
      return toolOk(ID, `wrote ${Buffer.byteLength(content)} bytes to ${params.path}`, {
        data: { path: abs, bytes: Buffer.byteLength(content) },
      });
    }
    if (o === "move") {
      const dest = resolveWithinRoot(String(params.dest)).abs;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(abs, dest);
      return toolOk(ID, `moved ${params.path} → ${params.dest}`, {
        data: { from: abs, to: dest },
      });
    }
    if (o === "delete") {
      await fsp.rm(abs, { recursive: true, force: true });
      return toolOk(ID, `deleted ${params.path} (restore point created)`, {
        data: { path: abs },
      });
    }
    return toolErr(ID, `unsupported operation: ${o}`);
  } catch (e) {
    return toolErr(ID, `${o} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
