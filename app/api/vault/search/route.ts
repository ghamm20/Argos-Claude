import { NextRequest } from "next/server";
import { retrieve } from "@/lib/vault/store";
import { EmbedError } from "@/lib/vault/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bound the query so a runaway client can't ship 10 MB to the embedder.
// The embed model has its own token limit anyway, but bouncing early
// is cheaper than embedding garbage.
const MAX_QUERY_LENGTH = 10_000;

export async function POST(req: NextRequest) {
  let body: { query?: string; topK?: number };
  try {
    body = (await req.json()) as { query?: string; topK?: number };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.query || typeof body.query !== "string") {
    return Response.json({ error: "query required" }, { status: 400 });
  }
  if (body.query.length > MAX_QUERY_LENGTH) {
    return Response.json(
      {
        error: `query exceeds ${MAX_QUERY_LENGTH} chars (got ${body.query.length})`,
      },
      { status: 400 }
    );
  }
  const topK =
    typeof body.topK === "number" && body.topK > 0 && body.topK <= 50
      ? body.topK
      : 5;
  try {
    const hits = await retrieve(body.query, topK);
    return Response.json({ hits });
  } catch (e) {
    if (e instanceof EmbedError) {
      return Response.json({ error: e.message }, { status: e.status ?? 502 });
    }
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
