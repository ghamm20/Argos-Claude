// app/api/auth/verify/route.ts
//
// Operator Auth (2026-05-28) — PIN verification endpoint.
//
// POST /api/auth/verify
//   Body: { pinHash: string }   — 64-char SHA-256 hex, client-computed
//   Success (200): { token: string, expiresIn: number }
//   Failure (401): { error: string }
//   Misconfig (503): if requirePin=false (auth disabled) or no PIN set
//
// The client never sends the raw PIN. It hashes locally via
// hashPinClient() in lib/auth-client.ts and POSTs the hex digest.
// Constant-time compare against settings.operatorPinHash. On match,
// a fresh 32-char hex token is generated, added to the per-process
// active-token store, and returned. The client stores it in
// sessionStorage and sends it as Authorization: Bearer on every
// /api/chat request.
//
// Tokens expire after 12 hours OR on server restart (whichever is
// sooner) — closing the browser tab also clears the sessionStorage
// copy, so the operator re-prompts on next launch.

import { NextRequest } from "next/server";
import { readSettings } from "@/lib/settings";
import {
  generateSessionToken,
  registerToken,
  timingSafeStringEqual,
  TOKEN_TTL_MS,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VerifyBody {
  pinHash?: unknown;
}

export async function POST(req: NextRequest) {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const candidate = body.pinHash;
  if (
    typeof candidate !== "string" ||
    !/^[a-f0-9]{64}$/i.test(candidate)
  ) {
    return Response.json(
      { error: "pinHash must be a 64-char hex SHA-256 string" },
      { status: 400 }
    );
  }

  const settings = await readSettings();
  if (!settings.requirePin) {
    // Auth not enabled — refuse to issue tokens. Defensive: the gate
    // shouldn't have called us in this state, but if a misconfigured
    // client did, we surface a clean 503 rather than minting tokens
    // nobody is checking.
    return Response.json(
      {
        error:
          "operator auth is disabled (requirePin=false); no token required",
      },
      { status: 503 }
    );
  }
  if (!settings.operatorPinHash) {
    return Response.json(
      { error: "no PIN configured; set one in Settings → Operator Authentication" },
      { status: 503 }
    );
  }

  const matches = timingSafeStringEqual(
    candidate.toLowerCase(),
    settings.operatorPinHash.toLowerCase()
  );
  if (!matches) {
    // Deliberately vague — don't leak whether the hash format was
    // structurally right but the value wrong (operator would have
    // figured that out from the structural validator above anyway).
    return Response.json({ error: "ACCESS DENIED" }, { status: 401 });
  }

  const token = generateSessionToken();
  registerToken(token);
  return Response.json({ token, expiresIn: TOKEN_TTL_MS });
}
