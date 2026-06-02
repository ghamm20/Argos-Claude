// app/api/loops/questions/route.ts
//
// Self-Evolving Loop Suite — active-learning questions. GET lists the questions
// ARGOS is waiting on (and recently answered ones); POST { id, answer } records
// an answer permanently. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { readQuestions, pendingQuestions, answerQuestion } from "@/lib/loops/questions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [pending, all] = await Promise.all([pendingQuestions(), readQuestions()]);
    return NextResponse.json({ ok: true, pending, recent: all.slice(-25).reverse() });
  } catch (e) {
    return NextResponse.json({ ok: false, pending: [], recent: [], error: String(e) }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string; answer?: string };
    const id = (body.id ?? "").trim();
    const answer = (body.answer ?? "").trim();
    if (!id || !answer) {
      return NextResponse.json({ ok: false, error: "id and answer are required" }, { status: 200 });
    }
    const ok = await answerQuestion(id, answer);
    return NextResponse.json({ ok, answered: ok, id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
