// app/api/memory/facts/route.ts
//
// Memory Phase (2026-06-02) — operator-facing surface for the semantic
// cross-session fact store (operator_facts.jsonl).
//
//   GET                  → { count, recent[5], memoryMdUpdated, memoryMdExists }
//   GET ?recall=<msg>    → adds { recall: { factsFound, injected, block } }
//   POST {userMessage, assistantMessage, sessionId?, persona?}
//                        → { ok, facts, stored } (runs the real extract+store)
//   DELETE               → { ok, cleared } (clears operator_facts.jsonl ONLY;
//                          MEMORY.md is never touched)
//
// Always graceful — never 500s for an empty/missing store.

import { NextRequest, NextResponse } from "next/server";
import {
  factsStatus,
  clearFacts,
  extractStoreAwait,
} from "@/lib/memory-extract";
import { retrieveMemories } from "@/lib/memory-retrieve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const status = await factsStatus();
    const recallQuery = req.nextUrl.searchParams.get("recall");
    if (recallQuery && recallQuery.trim()) {
      const r = await retrieveMemories(recallQuery);
      return NextResponse.json({
        ...status,
        recall: { factsFound: r.factsFound, injected: r.injected, block: r.block },
      });
    }
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json(
      { count: 0, recent: [], memoryMdUpdated: null, memoryMdExists: false, error: String(e) },
      { status: 200 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: {
    userMessage?: string;
    assistantMessage?: string;
    sessionId?: string | null;
    persona?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.userMessage !== "string" || !body.userMessage.trim()) {
    return NextResponse.json({ error: "userMessage required" }, { status: 400 });
  }
  const facts = await extractStoreAwait(
    body.userMessage,
    typeof body.assistantMessage === "string" ? body.assistantMessage : "",
    { sessionId: body.sessionId ?? null, persona: body.persona }
  );
  return NextResponse.json({ ok: true, facts, stored: facts.length });
}

export async function DELETE() {
  const cleared = await clearFacts();
  return NextResponse.json({ ok: true, cleared });
}
