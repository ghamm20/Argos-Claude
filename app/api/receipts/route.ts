// app/api/receipts/route.ts
//
// Phase 4 endpoint: returns the audit chain.
//   GET /api/receipts                     → full chain (paged tail)
//   GET /api/receipts?sessionId=ID        → only entries scoped to that session
//   GET /api/receipts?verify=1            → also runs the hash-chain verifier
//                                          and returns the result alongside
//
// "Receipts" framing: each entry is a tamper-evident proof that some
// event happened. Operator can pull the chain, hand it to a third party,
// they can re-verify the hash links independently with the same canonical
// JSON + sha256 algorithm — no special tooling.

import { NextRequest, NextResponse } from "next/server";
import { readChain, readSessionEntries, verifyChain } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RETURNED = 1000;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  const wantVerify = url.searchParams.get("verify") === "1";
  const tailParam = url.searchParams.get("tail");
  const tailN = tailParam ? Math.max(1, Math.min(MAX_RETURNED, +tailParam)) : null;

  try {
    let entries;
    if (sessionId) {
      entries = await readSessionEntries(sessionId);
    } else {
      entries = await readChain();
    }
    if (tailN !== null && entries.length > tailN) {
      entries = entries.slice(-tailN);
    } else if (!tailN && entries.length > MAX_RETURNED) {
      entries = entries.slice(-MAX_RETURNED);
    }

    const result: Record<string, unknown> = {
      count: entries.length,
      sessionId: sessionId ?? null,
      entries,
    };

    if (wantVerify) {
      const v = await verifyChain();
      result.verify = v;
    }

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
