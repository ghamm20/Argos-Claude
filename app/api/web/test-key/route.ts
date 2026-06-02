// app/api/web/test-key/route.ts
//
// Web Capability TIER 0 (2026-06-02) — "Test connection" for an API key.
// POST { key: "github", token?: string }
//   - if token provided, tests THAT token (pre-save check)
//   - else tests the stored (decrypted) token
// Returns { ok, status, login?, scopes?, rateLimit?, error? }. Never leaks the
// token back. Always 200 (the body's `ok` carries the verdict).

import { NextResponse } from "next/server";
import { webFetch, getApiKey } from "@/lib/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function testGithub(token: string | null) {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const r = await webFetch({
    source: "github",
    op: "test-key",
    url: "https://api.github.com/user",
    query: "auth test",
    ttlMs: 0, // never cache an auth probe
    headers,
    timeoutMs: 12_000,
    retries: 2,
  });
  if (r.ok) {
    let login: string | undefined;
    try {
      login = (JSON.parse(r.body) as { login?: string }).login;
    } catch {
      /* ignore */
    }
    return { ok: true, status: r.status, login, configured: !!token };
  }
  // 401 = bad token; without a token GitHub returns 401 on /user too.
  return {
    ok: false,
    status: r.status,
    error: token ? "token rejected by GitHub" : "no token configured",
  };
}

export async function POST(req: Request) {
  let body: { key?: string; token?: string | null };
  try {
    body = (await req.json()) as { key?: string; token?: string | null };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 200 });
  }
  const key = body.key ?? "github";
  if (key !== "github") {
    return NextResponse.json({ ok: false, error: `unknown key: ${key}` }, { status: 200 });
  }
  const token =
    typeof body.token === "string" && body.token.trim()
      ? body.token.trim()
      : await getApiKey("github");
  const result = await testGithub(token);
  return NextResponse.json(result);
}
