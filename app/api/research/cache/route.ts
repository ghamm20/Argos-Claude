// app/api/research/cache/route.ts
//
// Phase 10 — research cache admin endpoint.
//
//   GET    /api/research/cache  → cache status (entries, sizes, expiry)
//   DELETE /api/research/cache  → clear all entries

import { NextRequest } from "next/server";
import {
  getCacheStatus,
  clearCache,
  pruneCache,
} from "@/lib/research/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Opportunistic prune on read — keeps the on-disk file from
    // growing forever even when nobody hits DELETE.
    await pruneCache();
    const status = await getCacheStatus();
    return Response.json(status);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest) {
  try {
    const removed = await clearCache();
    return Response.json({ ok: true, removed });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
