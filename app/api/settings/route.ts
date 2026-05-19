import { NextRequest } from "next/server";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";
import { AVAILABLE_MODELS } from "@/lib/store";
import { readSettings, writeSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await readSettings();
  return Response.json(s);
}

export async function POST(req: NextRequest) {
  let body: { defaultPersona?: string; defaultModel?: string };
  try {
    body = (await req.json()) as {
      defaultPersona?: string;
      defaultModel?: string;
    };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: { defaultPersona?: PersonaId; defaultModel?: string } = {};

  if (body.defaultPersona !== undefined) {
    if (!PERSONA_BY_ID[body.defaultPersona as PersonaId]) {
      return Response.json(
        { error: `unknown persona: ${body.defaultPersona}` },
        { status: 400 }
      );
    }
    patch.defaultPersona = body.defaultPersona as PersonaId;
  }
  if (body.defaultModel !== undefined) {
    if (!AVAILABLE_MODELS.includes(body.defaultModel)) {
      return Response.json(
        {
          error: `model not in allowed list: ${body.defaultModel}`,
          availableModels: AVAILABLE_MODELS,
        },
        { status: 400 }
      );
    }
    patch.defaultModel = body.defaultModel;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json(
      { error: "no recognised fields to update" },
      { status: 400 }
    );
  }

  const next = await writeSettings(patch);
  return Response.json(next);
}
