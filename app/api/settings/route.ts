import { NextRequest } from "next/server";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";
import { AVAILABLE_MODELS } from "@/lib/store";
import { readSettings, writeSettings, type SettingsPatch } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await readSettings();
  return Response.json(s);
}

interface SettingsPostBody {
  defaultPersona?: string;
  defaultModel?: string;
  // Operator Auth (2026-05-28). Both fields are independently
  // patchable so the Settings UI can toggle requirePin on/off without
  // touching the stored hash, or set/clear the hash without changing
  // the toggle state.
  operatorPinHash?: string | null;
  requirePin?: boolean;
}

export async function POST(req: NextRequest) {
  let body: SettingsPostBody;
  try {
    body = (await req.json()) as SettingsPostBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: SettingsPatch = {};

  if (body.defaultPersona !== undefined) {
    if (typeof body.defaultPersona !== "string") {
      return Response.json(
        { error: "defaultPersona must be a string" },
        { status: 400 }
      );
    }
    if (!PERSONA_BY_ID[body.defaultPersona as PersonaId]) {
      return Response.json(
        { error: `unknown persona: ${body.defaultPersona}` },
        { status: 400 }
      );
    }
    patch.defaultPersona = body.defaultPersona as PersonaId;
  }
  if (body.defaultModel !== undefined) {
    if (typeof body.defaultModel !== "string") {
      return Response.json(
        { error: "defaultModel must be a string" },
        { status: 400 }
      );
    }
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
  if (body.operatorPinHash !== undefined) {
    // Accept either a 64-char hex SHA-256 (client-side hash output)
    // or explicit `null` to clear the PIN.
    if (body.operatorPinHash === null) {
      patch.operatorPinHash = null;
    } else if (
      typeof body.operatorPinHash === "string" &&
      /^[a-f0-9]{64}$/i.test(body.operatorPinHash)
    ) {
      patch.operatorPinHash = body.operatorPinHash.toLowerCase();
    } else {
      return Response.json(
        {
          error:
            "operatorPinHash must be null or a 64-char hex SHA-256 string",
        },
        { status: 400 }
      );
    }
  }
  if (body.requirePin !== undefined) {
    if (typeof body.requirePin !== "boolean") {
      return Response.json(
        { error: "requirePin must be a boolean" },
        { status: 400 }
      );
    }
    patch.requirePin = body.requirePin;
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
