// app/api/web/disabled/route.ts
//
// Web Capability TIER 3 (2026-06-02) — operator per-source kill switch.
//   GET  → { disabled: string[] }
//   POST { source, disabled } → { disabled: string[] }
// Enforced in lib/web/webFetch(). Always 200 on GET.

import { NextResponse } from "next/server";
import { listDisabled, setDisabled } from "@/lib/web/disabled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, disabled: await listDisabled() });
}

export async function POST(req: Request) {
  let body: { source?: string; disabled?: boolean };
  try {
    body = (await req.json()) as { source?: string; disabled?: boolean };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.source !== "string" || !body.source.trim()) {
    return NextResponse.json({ ok: false, error: "source is required" }, { status: 400 });
  }
  if (typeof body.disabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "disabled (boolean) is required" }, { status: 400 });
  }
  const disabled = await setDisabled(body.source.trim(), body.disabled);
  return NextResponse.json({ ok: true, disabled });
}
