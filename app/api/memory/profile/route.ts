// app/api/memory/profile/route.ts
//
// Phase 9 — operator profile read + write.
//
// GET  /api/memory/profile
//   Returns: { profile: OperatorProfile | null }
//
// POST /api/memory/profile
//   Body: Partial<OperatorProfile> — merged into the existing profile
//   (preserves untouched fields). last_updated is set automatically.
//   Returns: { ok: true, profile: OperatorProfile }

import { NextRequest } from "next/server";
import {
  getOperatorProfile,
  writeOperatorProfile,
} from "@/lib/memory/store";
import type { OperatorProfile } from "@/lib/memory/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const profile = await getOperatorProfile();
    return Response.json({ profile });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: Partial<OperatorProfile>;
  try {
    body = (await req.json()) as Partial<OperatorProfile>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "body must be an object" }, { status: 400 });
  }

  // Light type-validation. We don't reject extras — Partial<OperatorProfile>
  // accepts any subset, and unknown keys are simply ignored by the merge.
  if (body.name !== undefined && typeof body.name !== "string") {
    return Response.json({ error: "name must be a string" }, { status: 400 });
  }
  if (body.role !== undefined && typeof body.role !== "string") {
    return Response.json({ error: "role must be a string" }, { status: 400 });
  }
  if (body.context !== undefined && typeof body.context !== "string") {
    return Response.json({ error: "context must be a string" }, { status: 400 });
  }
  if (body.preferences !== undefined) {
    if (typeof body.preferences !== "object" || body.preferences === null) {
      return Response.json(
        { error: "preferences must be an object of string→string" },
        { status: 400 }
      );
    }
    for (const [k, v] of Object.entries(body.preferences)) {
      if (typeof v !== "string") {
        return Response.json(
          { error: `preferences.${k} must be a string` },
          { status: 400 }
        );
      }
    }
  }

  try {
    const profile = await writeOperatorProfile(body);
    return Response.json({ ok: true, profile });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
