// lib/tools/fs-guard.ts
//
// Tools Phase (2026-06-02) — the HARD ARGOS_ROOT boundary for filesystem
// tools (T15) plus a source resolver for read-only tools (T6/T7/T13) that
// accept either a path (within the boundary) or a vault docId.

import path from "node:path";
import { promises as fsp } from "node:fs";
import { argosRoot } from "../vault/paths";
import { listDocuments } from "../vault/store";
import { storedDocPath } from "../vault/paths";

/** Resolve a path and assert it stays inside ARGOS_ROOT. Rejects any path that
 *  escapes the boundary (../, absolute paths outside root, etc.). */
export function resolveWithinRoot(p: string): {
  ok: boolean;
  abs: string;
  error?: string;
} {
  const root = path.resolve(argosRoot());
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return { ok: false, abs, error: `path escapes the ARGOS_ROOT boundary: ${p}` };
  }
  return { ok: true, abs };
}

/** Resolve a readable source from params: { path } (within root) or
 *  { docId } (vault document). Returns the absolute path. */
export async function resolveSourcePath(
  params: Record<string, unknown>
): Promise<{ ok: boolean; abs?: string; error?: string }> {
  const docId = typeof params.docId === "string" ? params.docId.trim() : "";
  if (docId) {
    try {
      const docs = await listDocuments();
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return { ok: false, error: `vault doc not found: ${docId}` };
      return { ok: true, abs: storedDocPath(doc.id, doc.filename) };
    } catch (e) {
      return { ok: false, error: `vault lookup failed: ${(e as Error).message}` };
    }
  }
  const p = typeof params.path === "string" ? params.path.trim() : "";
  if (!p) return { ok: false, error: "provide a path or docId" };
  const r = resolveWithinRoot(p);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    await fsp.access(r.abs);
  } catch {
    return { ok: false, error: `file not found: ${p}` };
  }
  return { ok: true, abs: r.abs };
}
