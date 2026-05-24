// app/api/chat/sessions/[id]/export/route.ts
//
// Phase 4 tamper-evident JSON export.
//
//   GET /api/chat/sessions/:id/export       → full bundle as JSON download
//
// Bundle shape:
// {
//   bundleVersion: 1,
//   exportedAt: <ms>,
//   argosVersion: <build version>,
//   session: <PersistedSession>,           // messages, persona, model, etc.
//   audit: <AuditEntry[]>,                  // chain entries scoped to this session
//   chainSummary: <ChainVerifyResult>,      // full-chain verify at export time
//   bundleHash: <sha256 hex>                // hash of canonical(bundle minus bundleHash)
// }
//
// Verification: third party can recompute bundleHash from the rest +
// re-run audit-chain verifier; either failing indicates tampering.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { readSession } from "@/lib/sessions";
import { readSessionEntries, verifyChain, canonicalJson } from "@/lib/audit";
import { getRuntimeInfo } from "@/lib/runtime-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUNDLE_VERSION = 1;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  if (!id || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "invalid session id" }, { status: 400 });
  }

  try {
    const session = await readSession(id);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    const [auditEntries, chainSummary, runtime] = await Promise.all([
      readSessionEntries(id),
      verifyChain(),
      getRuntimeInfo(),
    ]);

    const exportedAt = Date.now();

    // Bundle without bundleHash first; hash that, then attach the hash.
    const bundleWithoutHash = {
      bundleVersion: BUNDLE_VERSION,
      exportedAt,
      argosVersion: runtime.version,
      session,
      audit: auditEntries,
      chainSummary,
    };
    const bundleHash = createHash("sha256")
      .update(canonicalJson(bundleWithoutHash))
      .digest("hex");

    const bundle = { ...bundleWithoutHash, bundleHash };

    // Suggested filename — operator gets a downloadable artifact.
    const filename = `argos-session-${id}-${new Date(exportedAt)
      .toISOString()
      .slice(0, 10)}.json`;

    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
