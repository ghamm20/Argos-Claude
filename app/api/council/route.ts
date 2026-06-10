// app/api/council/route.ts
//
// G4 (2026-06-09) — parallel persona reasoning (Power Mode only). Dispatches one
// query to N personas CONCURRENTLY on ample tier. Refuses (200 with available:
// false) on lean/mid — running N heavy models on 8GB would thrash.
//
//   POST { query: string, personas?: PersonaId[] }
//     → CouncilResult { available, reason, members[], durationMs }

import { NextRequest, NextResponse } from "next/server";
import { getGpuProfile } from "@/lib/gpu/detect";
import { runCouncil } from "@/lib/power/council";
import type { PersonaId } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_COUNCIL: PersonaId[] = ["bartimaeus", "sage", "bobby"];

export async function POST(req: NextRequest) {
  let body: { query?: string; personas?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });
  const personas = (Array.isArray(body.personas) && body.personas.length ? body.personas : DEFAULT_COUNCIL) as PersonaId[];

  const profile = await getGpuProfile();
  const result = await runCouncil(query, personas, { profile });
  return NextResponse.json(result);
}
