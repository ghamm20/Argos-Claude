// lib/tools/fs-guard.ts
//
// Tools Phase (2026-06-02) — the HARD ARGOS_ROOT boundary for filesystem
// tools (T15) plus a source resolver for read-only tools (T6/T7/T13) that
// accept either a path (within the boundary) or a vault docId.

import path from "node:path";
import fs, { promises as fsp } from "node:fs";
import { argosRoot } from "../vault/paths";
import { listDocuments } from "../vault/store";
import { storedDocPath } from "../vault/paths";

/** Lexical boundary check: is `abs` inside `root` by pure path arithmetic?
 *  Catches `../`, absolute paths outside root, etc. — but NOT symlink escapes
 *  (a symlink's lexical path stays inside; its target is elsewhere). */
function lexicallyInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

/** The longest ANCESTOR of `abs` that exists on disk, plus the non-existing
 *  tail. For a not-yet-created file this is (parent dir that exists, filename);
 *  for an existing path it is (abs, ""). Lets us realpath the part that exists
 *  (resolving any symlinks in it) without failing on the part that doesn't. */
function splitExisting(abs: string): { existing: string; tail: string } {
  let existing = abs;
  let tail = "";
  // Bounded by the filesystem root — dirname is idempotent at the top.
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    tail = tail ? path.join(path.basename(existing), tail) : path.basename(existing);
    if (parent === existing) break; // reached fs root; nothing exists
    existing = parent;
  }
  return { existing, tail };
}

/** Resolve a path and assert it stays inside ARGOS_ROOT. Rejects any path that
 *  escapes the boundary — including via SYMLINKS. Two layers:
 *   1. Lexical check on the requested path (cheap; catches ../ and absolutes).
 *   2. Realpath check: resolve symlinks on the existing portion of the path
 *      (and realpath the root), then re-verify the boundary. A symlink INSIDE
 *      ARGOS_ROOT whose target is outside is now caught — its lexical path is
 *      inside, but its realpath is not. The not-yet-existing-file case is
 *      handled by realpath-ing the deepest existing ancestor and re-joining
 *      the tail. (Fable scope-review risk #7, 2026-06-09.)
 *
 *  Returns `abs` = the REALPATH-resolved absolute path, so callers operate on
 *  the canonical location (a same-root symlink resolves to its real target). */
export function resolveWithinRoot(p: string): {
  ok: boolean;
  abs: string;
  error?: string;
} {
  const root = path.resolve(argosRoot());
  const abs = path.resolve(root, p);

  // Layer 1 — lexical (pre-realpath: catches the obvious ../ and absolute cases
  // with a clear message even when the path doesn't exist yet).
  if (!lexicallyInside(root, abs)) {
    return { ok: false, abs, error: `path escapes the ARGOS_ROOT boundary: ${p}` };
  }

  // Layer 2 — realpath. Resolve symlinks on the root and on the existing part
  // of the requested path, then re-check. realpathSync throws only if `root`
  // itself is missing (a deployment error, not a path issue) — fall back to the
  // lexical result rather than crash the tool.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: true, abs };
  }
  const { existing, tail } = splitExisting(abs);
  let realExisting: string;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    // The existing ancestor became unreadable between existsSync and realpath
    // (race / permissions) — treat as unresolvable and reject conservatively.
    return { ok: false, abs, error: `path could not be resolved safely: ${p}` };
  }
  const realAbs = tail ? path.join(realExisting, tail) : realExisting;
  if (!lexicallyInside(realRoot, realAbs)) {
    return {
      ok: false,
      abs: realAbs,
      error: `path escapes the ARGOS_ROOT boundary via symlink: ${p}`,
    };
  }
  return { ok: true, abs: realAbs };
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
