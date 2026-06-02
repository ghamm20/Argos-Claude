// app/api/runtime/route.ts
//
// Runtime introspection (2026-06-02). Returns the build-baked version + live
// ARGOS_ROOT / Ollama URL. force-dynamic so it always reflects the running
// process (not a static prerender). The version is baked at BUILD time inside
// the `.next` bundle (see lib/runtime-info.ts), so it is correct regardless of
// the deployed cwd's package.json — this is the canonical way to verify the
// HUD BUILD label without a browser. Always 200.

import { NextResponse } from "next/server";
import { getRuntimeInfo } from "@/lib/runtime-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const info = await getRuntimeInfo();
    return NextResponse.json({ ok: true, ...info });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
