// app/api/memory/list/route.ts
//
// Phase 9 — list non-pruned memory entries.
//
// GET /api/memory/list?persona=bartimaeus&tier=short_term
//
// Query params:
//   persona  required — one of bartimaeus|juniper|sage|bobby|shared
//   tier     optional — one of short_term|entity|operator_profile|project
//                       (omitted = all tiers for that persona)
//   limit    optional — int, defaults to no limit
//
// Returns: { persona, tier?, entries: MemoryEntry[] }

import { NextRequest } from "next/server";
import {
  readMemories,
  readAllMemories,
} from "@/lib/memory/store";
import {
  isMemoryTier,
  isMemoryPersonaScope,
} from "@/lib/memory/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const persona = searchParams.get("persona");
  const tier = searchParams.get("tier");
  const limitRaw = searchParams.get("limit");

  if (!persona || !isMemoryPersonaScope(persona)) {
    return Response.json(
      { error: "persona query param required (bartimaeus|juniper|sage|bobby|shared)" },
      { status: 400 }
    );
  }

  let limit: number | undefined;
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (Number.isNaN(n) || n <= 0 || n > 10_000) {
      return Response.json(
        { error: "limit must be a positive integer ≤ 10000" },
        { status: 400 }
      );
    }
    limit = n;
  }

  try {
    if (tier === null) {
      const entries = await readAllMemories(persona);
      return Response.json({
        persona,
        tier: null,
        entries: typeof limit === "number" ? entries.slice(0, limit) : entries,
      });
    }
    if (!isMemoryTier(tier)) {
      return Response.json(
        { error: "tier must be short_term|entity|operator_profile|project" },
        { status: 400 }
      );
    }
    const entries = await readMemories(persona, tier, limit);
    return Response.json({ persona, tier, entries });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
