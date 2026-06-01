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
  // Phase 11 — research scheduler + alerts. Each field independently
  // patchable so the Tools UI can flip the scheduler without touching
  // Pushover keys, etc.
  operatorPushoverUserKey?: string | null;
  operatorPushoverApiToken?: string | null;
  // Task 5 — Twilio SMS fallback creds. Each independently patchable.
  twilioAccountSid?: string | null;
  twilioAuthToken?: string | null;
  twilioFrom?: string | null;
  twilioTo?: string | null;
  researchSchedule?: Partial<{
    enabled: boolean;
    weatherMinutes: number;
    newsMinutes: number;
    aiUpdatesMinutes: number;
    arxivMinutes: number;
  }>;
  researchWatchlist?: string[];
  researchAlertConfidenceThreshold?: number;
  researchArxivTopics?: string[];
  // Phase 10 Heartbeat — ambient dispatcher toggle + cadence.
  heartbeat?: Partial<{ enabled: boolean; intervalMinutes: number }>;
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

  // Phase 11 fields
  if (body.operatorPushoverUserKey !== undefined) {
    if (
      body.operatorPushoverUserKey !== null &&
      typeof body.operatorPushoverUserKey !== "string"
    ) {
      return Response.json(
        { error: "operatorPushoverUserKey must be a string or null" },
        { status: 400 }
      );
    }
    patch.operatorPushoverUserKey = body.operatorPushoverUserKey;
  }
  if (body.operatorPushoverApiToken !== undefined) {
    if (
      body.operatorPushoverApiToken !== null &&
      typeof body.operatorPushoverApiToken !== "string"
    ) {
      return Response.json(
        { error: "operatorPushoverApiToken must be a string or null" },
        { status: 400 }
      );
    }
    patch.operatorPushoverApiToken = body.operatorPushoverApiToken;
  }
  // Task 5 — Twilio SMS fallback creds (each string | null).
  for (const field of ["twilioAccountSid", "twilioAuthToken", "twilioFrom", "twilioTo"] as const) {
    const v = body[field];
    if (v !== undefined) {
      if (v !== null && typeof v !== "string") {
        return Response.json(
          { error: `${field} must be a string or null` },
          { status: 400 }
        );
      }
      patch[field] = v;
    }
  }
  if (body.researchSchedule !== undefined) {
    if (typeof body.researchSchedule !== "object" || body.researchSchedule === null) {
      return Response.json(
        { error: "researchSchedule must be an object" },
        { status: 400 }
      );
    }
    const current = (await readSettings()).researchSchedule;
    const merged = { ...current, ...body.researchSchedule };
    // Validate minutes are non-negative integers (0 = disabled).
    for (const k of [
      "weatherMinutes",
      "newsMinutes",
      "aiUpdatesMinutes",
      "arxivMinutes",
    ] as const) {
      const v = merged[k];
      if (typeof v !== "number" || v < 0 || !Number.isFinite(v)) {
        return Response.json(
          { error: `researchSchedule.${k} must be a non-negative number` },
          { status: 400 }
        );
      }
    }
    if (typeof merged.enabled !== "boolean") {
      return Response.json(
        { error: "researchSchedule.enabled must be a boolean" },
        { status: 400 }
      );
    }
    patch.researchSchedule = merged;
  }

  // Phase 10 Heartbeat — merge + validate.
  if (body.heartbeat !== undefined) {
    if (typeof body.heartbeat !== "object" || body.heartbeat === null) {
      return Response.json(
        { error: "heartbeat must be an object" },
        { status: 400 }
      );
    }
    const current = (await readSettings()).heartbeat;
    const merged = { ...current, ...body.heartbeat };
    if (typeof merged.enabled !== "boolean") {
      return Response.json(
        { error: "heartbeat.enabled must be a boolean" },
        { status: 400 }
      );
    }
    if (
      typeof merged.intervalMinutes !== "number" ||
      merged.intervalMinutes < 1 ||
      !Number.isFinite(merged.intervalMinutes)
    ) {
      return Response.json(
        { error: "heartbeat.intervalMinutes must be a number ≥ 1" },
        { status: 400 }
      );
    }
    patch.heartbeat = merged;
  }
  if (body.researchWatchlist !== undefined) {
    if (
      !Array.isArray(body.researchWatchlist) ||
      !body.researchWatchlist.every((s) => typeof s === "string")
    ) {
      return Response.json(
        { error: "researchWatchlist must be an array of strings" },
        { status: 400 }
      );
    }
    patch.researchWatchlist = body.researchWatchlist;
  }
  if (body.researchAlertConfidenceThreshold !== undefined) {
    if (
      typeof body.researchAlertConfidenceThreshold !== "number" ||
      body.researchAlertConfidenceThreshold < 0 ||
      body.researchAlertConfidenceThreshold > 1
    ) {
      return Response.json(
        { error: "researchAlertConfidenceThreshold must be a number in [0, 1]" },
        { status: 400 }
      );
    }
    patch.researchAlertConfidenceThreshold = body.researchAlertConfidenceThreshold;
  }
  if (body.researchArxivTopics !== undefined) {
    if (
      !Array.isArray(body.researchArxivTopics) ||
      !body.researchArxivTopics.every((s) => typeof s === "string")
    ) {
      return Response.json(
        { error: "researchArxivTopics must be an array of strings" },
        { status: 400 }
      );
    }
    patch.researchArxivTopics = body.researchArxivTopics;
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
