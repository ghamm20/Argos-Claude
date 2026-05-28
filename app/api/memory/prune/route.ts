// app/api/memory/prune/route.ts
//
// Phase 9 — tombstone a memory entry. Physically the entry stays in
// the JSONL file (preserves per-file hash chain); a new line with
// pruned:true gets appended. Readers filter pruned at read time.
//
// DELETE /api/memory/prune?id=<entryId>
//
// Idempotent — repruning an already-pruned entry is silent success.
// Unknown ids are also silent success (REST DELETE convention).

import { NextRequest } from "next/server";
import { pruneMemory } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id || id.length === 0) {
    return Response.json(
      { error: "id query param required" },
      { status: 400 }
    );
  }
  try {
    await pruneMemory(id);
    return Response.json({ ok: true, id });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
