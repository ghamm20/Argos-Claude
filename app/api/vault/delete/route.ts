import { NextRequest } from "next/server";
import { deleteDocument } from "@/lib/vault/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { docId?: string };
  try {
    body = (await req.json()) as { docId?: string };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.docId || typeof body.docId !== "string") {
    return Response.json({ error: "docId required" }, { status: 400 });
  }
  // Bound docId — anything past a reasonable hash length is junk.
  // Existing docIds are 16-char hex; allow some headroom for future
  // schemes but reject pathological lengths early.
  if (body.docId.length > 128) {
    return Response.json(
      { error: `docId too long (max 128 chars, got ${body.docId.length})` },
      { status: 400 }
    );
  }
  const removed = await deleteDocument(body.docId);
  return Response.json({ ok: true, removed });
}
