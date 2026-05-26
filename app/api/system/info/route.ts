// app/api/system/info/route.ts
//
// v1.1 — runtime system info for the HUD. Reads at REQUEST time, not
// build time, so the deployed payload reflects the actual ARGOS_ROOT
// the launcher set (not the dev-source path baked at build time).
//
// Why this exists: app/page.tsx renders statically (the `○` symbol in
// Next.js build output). That bakes `getRuntimeInfo()` into the HTML
// shipped to the client with the wrong argosRoot. This route is
// force-dynamic; the HUD fetches it on mount and updates the display
// to reflect the real env var the launcher exported.

import { NextResponse } from "next/server";
import { getRuntimeInfo } from "@/lib/runtime-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const info = await getRuntimeInfo();
    return NextResponse.json(info);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
