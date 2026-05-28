// app/api/research/run/route.ts
//
// Phase 10 — operator-triggered research run. Used by the Tools page
// "Run now" buttons (Weather ATL, Weather ORL, News ATL, News ORL,
// AI Updates) to fire the pipeline on demand without going through
// chat. Returns the resulting ResearchReport.
//
// POST /api/research/run
// Body: { stream: "weather_atl"|"weather_orl"|"news_atl"|"news_orl"|"ai_updates"|"custom", query?: string }

import { NextRequest } from "next/server";
import { runResearch } from "@/lib/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same hard cap as the route's pipeline budget — leaves room for
// any setup/teardown overhead at the route layer.
export const maxDuration = 60;

const STREAM_QUERIES: Record<string, string> = {
  weather_atl: "weather in Atlanta",
  weather_orl: "weather in Orlando",
  news_atl: "latest news Atlanta",
  news_orl: "latest news Orlando",
  ai_updates: "latest AI news and model releases",
};

interface RunBody {
  stream?: unknown;
  query?: unknown;
}

export async function POST(req: NextRequest) {
  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let userMessage: string | null = null;
  if (typeof body.stream === "string" && STREAM_QUERIES[body.stream]) {
    userMessage = STREAM_QUERIES[body.stream];
  } else if (body.stream === "custom") {
    if (typeof body.query !== "string" || body.query.trim().length === 0) {
      return Response.json(
        { error: "custom stream requires non-empty query string" },
        { status: 400 }
      );
    }
    userMessage = body.query.trim();
  } else {
    return Response.json(
      {
        error:
          "stream must be one of weather_atl|weather_orl|news_atl|news_orl|ai_updates|custom",
      },
      { status: 400 }
    );
  }

  try {
    const report = await runResearch(userMessage, "bartimaeus");
    if (!report) {
      // Should be unreachable for the named streams (they all
      // contain trigger keywords), but custom queries can land here.
      return Response.json(
        {
          ok: false,
          error: "query did not match a research trigger; no pipeline ran",
        },
        { status: 200 }
      );
    }
    return Response.json({ ok: true, report });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
