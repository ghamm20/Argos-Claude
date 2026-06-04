// app/api/tools/persona-tools/route.ts
//
// Diagnostic (v2.3.11 — persona tool distribution). Exposes, per conversational
// persona: its scoped tool subset, the tool ids actually rendered into its
// tool-awareness block (Bart = full, others scoped), and whether INTEGRITY
// DOCTRINE is the FIRST principle in its system prompt. Lets
// scripts/validate-persona-tools.mjs assert the distribution deterministically
// against the SAME functions the chat route uses — no model needed.
//
//   GET → { allToolCount, personas: { <id>: { tools, count,
//           awarenessToolIds, integrityDoctrineFirst } } }

import { NextResponse } from "next/server";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import { allToolIds } from "@/lib/tools/registry";
import { buildToolAwarenessBlock } from "@/lib/tools/chat-tools";
import { toolsForPersona } from "@/lib/persona-tool-subsets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONVERSATIONAL: PersonaId[] = ["bartimaeus", "sage", "bobby", "juniper"];

export async function GET() {
  const ids = allToolIds();
  const personas: Record<string, unknown> = {};
  for (const p of PERSONAS) {
    if (!CONVERSATIONAL.includes(p.id)) continue;
    const tools = toolsForPersona(p.id, ids);
    // Render the awareness block exactly as the chat route does for this persona.
    const block = buildToolAwarenessBlock(p.id === "bartimaeus" ? undefined : tools);
    const awarenessToolIds = block
      .split("\n")
      .map((l) => /^- ([a-z0-9_]+) —/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => m[1]);
    personas[p.id] = {
      tools,
      count: tools.length,
      awarenessToolIds,
      integrityDoctrineFirst: p.systemPrompt.trimStart().startsWith("INTEGRITY DOCTRINE"),
    };
  }
  return NextResponse.json({ allToolCount: ids.length, personas });
}
