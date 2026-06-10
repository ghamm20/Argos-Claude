// app/api/chat/route.ts
//
// Phase 2 (2026-06-10) — thin shim. The chat orchestrator (the former
// 1,400-line POST handler) lives in lib/chat/orchestrator.ts; wire types in
// lib/chat/wire.ts; prompt blocks in lib/chat/blocks.ts; module boot kickers
// in lib/chat/boot.ts (imported here for side effects, preserving the
// original "boot on first route load" timing). Pure refactor — zero behavior
// change, proven byte-identical by scripts/regress-phase2.mjs.

import "@/lib/chat/boot";
import { handleChat } from "@/lib/chat/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Parameters<typeof handleChat>[0]) {
  return handleChat(req);
}
