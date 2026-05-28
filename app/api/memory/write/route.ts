// app/api/memory/write/route.ts
//
// Phase 9 — explicit operator memory write.
//
// POST /api/memory/write
// Body: {
//   persona_id: "bartimaeus"|"juniper"|"sage"|"bobby"|"shared",
//   tier: "short_term"|"entity"|"operator_profile"|"project",
//   content: string,
//   importance?: number (0..1, default 0.7),
//   tags?: string[]
// }
//
// Source is always "operator_explicit" for this endpoint — that's
// the whole point. Conversation-extracted memories use the in-route
// path in /api/chat.

import { NextRequest } from "next/server";
import { writeMemory } from "@/lib/memory/store";
import {
  isMemoryTier,
  isMemoryPersonaScope,
} from "@/lib/memory/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WriteBody {
  persona_id?: unknown;
  tier?: unknown;
  content?: unknown;
  importance?: unknown;
  tags?: unknown;
}

export async function POST(req: NextRequest) {
  let body: WriteBody;
  try {
    body = (await req.json()) as WriteBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!isMemoryPersonaScope(body.persona_id)) {
    return Response.json(
      { error: "persona_id required (bartimaeus|juniper|sage|bobby|shared)" },
      { status: 400 }
    );
  }
  if (!isMemoryTier(body.tier)) {
    return Response.json(
      { error: "tier required (short_term|entity|operator_profile|project)" },
      { status: 400 }
    );
  }
  if (typeof body.content !== "string" || body.content.trim().length === 0) {
    return Response.json(
      { error: "content must be a non-empty string" },
      { status: 400 }
    );
  }
  if (body.content.length > 10_000) {
    return Response.json(
      { error: "content exceeds 10000 chars" },
      { status: 400 }
    );
  }

  let importance = 0.7;
  if (body.importance !== undefined) {
    if (
      typeof body.importance !== "number" ||
      body.importance < 0 ||
      body.importance > 1
    ) {
      return Response.json(
        { error: "importance must be a number in [0, 1]" },
        { status: 400 }
      );
    }
    importance = body.importance;
  }

  let tags: string[] = [];
  if (body.tags !== undefined) {
    if (
      !Array.isArray(body.tags) ||
      !body.tags.every((t) => typeof t === "string")
    ) {
      return Response.json(
        { error: "tags must be an array of strings" },
        { status: 400 }
      );
    }
    tags = body.tags as string[];
  }

  try {
    const now = new Date().toISOString();
    const entry = await writeMemory({
      tier: body.tier,
      persona_id: body.persona_id,
      created_at: now,
      updated_at: now,
      content: body.content.trim(),
      source: "operator_explicit",
      importance,
      tags,
      pruned: false,
    });
    return Response.json({ ok: true, entry });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
