import { NextRequest } from "next/server";
import { readSession, deleteSession, isSafeSessionId } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/chat/sessions/[id] — return full persisted session. */
export async function GET(
  _req: NextRequest,
  ctx: { params: { id: string } }
) {
  const id = ctx.params.id;
  if (!isSafeSessionId(id)) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  try {
    const session = await readSession(id);
    if (!session) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json(session);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

/** DELETE /api/chat/sessions/[id] — remove a session file. */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: { id: string } }
) {
  const id = ctx.params.id;
  if (!isSafeSessionId(id)) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  try {
    const removed = await deleteSession(id);
    return Response.json({ ok: true, removed });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
