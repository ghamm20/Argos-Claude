// app/api/memory/facts/route.ts
//
// Memory Phase + Audit (2026-06-02) — operator surface for the semantic
// cross-session fact store (operator_facts.jsonl).
//
//   GET                  → { count, recent[5], memoryMdUpdated, memoryMdExists,
//                            facts[] (full, filtered, sorted), total, filtered,
//                            summary }
//   GET ?recall=<msg>    → adds { recall: {...} }
//   GET ?category&persona&status&minConfidence&maxConfidence&from&to&search&sort&dir
//                        → filtered + sorted audit list
//   POST {userMessage, assistantMessage, ...}  → extract+store
//   DELETE               → clear operator_facts.jsonl (MEMORY.md untouched)

import { NextRequest, NextResponse } from "next/server";
import { factsStatus, clearFacts, extractStoreAwait, readFacts } from "@/lib/memory-extract";
import { retrieveMemories } from "@/lib/memory-retrieve";
import { filterFacts, sortFacts, auditSummary, type SortKey } from "@/lib/memory-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORT_KEYS = new Set<SortKey>(["timestamp", "persona", "category", "confidence", "status", "fact"]);

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const status = await factsStatus();

    const recallQuery = sp.get("recall");
    if (recallQuery && recallQuery.trim()) {
      const r = await retrieveMemories(recallQuery);
      return NextResponse.json({
        ...status,
        recall: { factsFound: r.factsFound, injected: r.injected, block: r.block },
      });
    }

    const all = await readFacts();
    const num = (k: string): number | undefined => {
      const v = sp.get(k);
      if (v === null || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const filtered = filterFacts(all, {
      category: sp.get("category") ?? undefined,
      persona: sp.get("persona") ?? undefined,
      status: sp.get("status") ?? undefined,
      minConfidence: num("minConfidence"),
      maxConfidence: num("maxConfidence"),
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      search: sp.get("search") ?? undefined,
    });
    const sortKey = sp.get("sort") as SortKey | null;
    const dir = sp.get("dir") === "asc" ? "asc" : "desc";
    const sorted = sortFacts(filtered, sortKey && SORT_KEYS.has(sortKey) ? sortKey : "timestamp", dir);

    return NextResponse.json({
      ...status,
      facts: sorted,
      total: all.length,
      filtered: sorted.length,
      summary: await auditSummary(),
    });
  } catch (e) {
    return NextResponse.json(
      { count: 0, recent: [], facts: [], memoryMdUpdated: null, memoryMdExists: false, error: String(e) },
      { status: 200 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { userMessage?: string; assistantMessage?: string; sessionId?: string | null; persona?: string };
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
