import { NextRequest } from "next/server";
import {
  listSessions,
  writeSession,
  generateSessionId,
  deriveTitle,
  validateSession,
  SESSION_VERSION,
  type PersistedSession,
} from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/chat/sessions — list session summaries, most-recent first. */
export async function GET() {
  try {
    const sessions = await listSessions();
    return Response.json({ sessions, count: sessions.length });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/chat/sessions — create a new session OR save an
 * existing one's full state.
 *
 * Body shape:
 *   - To create: { personaId, model, messages: [...] }
 *     The route generates an id, derives a title from the first user
 *     message, and timestamps.
 *   - To save existing (upsert): { id, personaId, model, messages,
 *     title?, createdAt? }
 *     Server preserves createdAt if provided; updatedAt is always
 *     set server-side.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.personaId !== "string" || body.personaId.length === 0) {
    return Response.json({ error: "personaId required (string)" }, { status: 400 });
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return Response.json({ error: "model required (string)" }, { status: 400 });
  }
  if (!Array.isArray(body.messages)) {
    return Response.json({ error: "messages required (array)" }, { status: 400 });
  }

  const now = Date.now();
  const isUpdate = typeof body.id === "string" && body.id.length > 0;
  const id = isUpdate ? (body.id as string) : generateSessionId();
  const createdAt =
    typeof body.createdAt === "number" ? (body.createdAt as number) : now;
  const title =
    typeof body.title === "string" && (body.title as string).trim().length > 0
      ? (body.title as string).trim().slice(0, 200)
      : deriveTitle(body.messages as PersistedSession["messages"]);

  const session: PersistedSession = {
    version: SESSION_VERSION,
    id,
    title,
    personaId: body.personaId,
    model: body.model,
    messages: body.messages as PersistedSession["messages"],
    createdAt,
    updatedAt: now,
  };

  // Validate the assembled object before writing.
  const validated = validateSession(session);
  if (!validated) {
    return Response.json({ error: "session failed validation" }, { status: 400 });
  }

  try {
    await writeSession(validated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 413 if the payload exceeds the size cap, else 500
    const status = /exceeds .* byte cap/i.test(msg) ? 413 : 500;
    return Response.json({ error: msg }, { status });
  }
  return Response.json({
    id: validated.id,
    title: validated.title,
    createdAt: validated.createdAt,
    updatedAt: validated.updatedAt,
    messageCount: validated.messages.length,
  });
}
