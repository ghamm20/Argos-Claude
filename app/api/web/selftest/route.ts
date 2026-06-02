// app/api/web/selftest/route.ts
//
// Web Capability TIER 0 (2026-06-02) — in-process exerciser for the four infra
// modules, so scripts/smoke-web-infra.mjs can verify them through real code
// (the repo convention: pure libs tested via a diagnostic route). Harmless:
// writes only test keys into the (smoke's temp) ARGOS_ROOT.
//
// POST { flakyUrl?: string, nonce?: string }
//   flakyUrl — a local endpoint that fails a few times then 200s; proves the
//              http-client retry/backoff path.
//   nonce    — isolates the rate-limiter + audit test source per run.

import { NextResponse } from "next/server";
import { httpRequest } from "@/lib/web/http-client";
import { cacheGet, cacheSet, cacheKey } from "@/lib/web/cache";
import { take } from "@/lib/web/rate-limiter";
import { appendWebAudit, queryAudit } from "@/lib/web/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  let body: { flakyUrl?: string; nonce?: string } = {};
  try {
    body = (await req.json()) as { flakyUrl?: string; nonce?: string };
  } catch {
    /* empty body ok */
  }
  const nonce = body.nonce ?? "n";
  const out: Record<string, unknown> = {};

  // 1) http-client retry/backoff against a flaky local endpoint.
  if (body.flakyUrl) {
    const r = await httpRequest(body.flakyUrl, { retries: 4, timeoutMs: 5000 });
    out.http = { ok: r.ok, status: r.status, attempts: r.attempts, error: r.error ?? null };
  } else {
    out.http = { skipped: true };
  }

  // 2) cache hit + expiry.
  const hitKey = cacheKey(`selftest://hit/${nonce}`);
  await cacheSet(hitKey, "selftest://hit", { v: 1 }, 60_000);
  const hit = await cacheGet<{ v: number }>(hitKey);
  const expKey = cacheKey(`selftest://expire/${nonce}`);
  await cacheSet(expKey, "selftest://expire", { v: 2 }, 40);
  await sleep(120);
  const expired = await cacheGet<{ v: number }>(expKey);
  out.cache = {
    hit: hit?.v === 1,
    expiredMiss: expired === null,
  };

  // 3) rate-limiter bucket (rpm 6, burst 2 → 2 allowed, 3rd denied with wait).
  const src = `selftest-${nonce}`;
  const cfg = { requestsPerMinute: 6, burst: 2 };
  const a = await take(src, cfg);
  const b = await take(src, cfg);
  const c = await take(src, cfg);
  out.rate = {
    first: a.allowed,
    second: b.allowed,
    third: c.allowed,
    waitMs: c.waitMs,
  };

  // 4) audit append + query.
  await appendWebAudit({
    source: src,
    op: "selftest",
    query: "selftest entry",
    url: "selftest://audit",
    status: 200,
    ok: true,
    latencyMs: 1,
    cacheHit: false,
    cost: 0,
    error: null,
  });
  const summary = await queryAudit({ source: src });
  out.audit = {
    appended: summary.total >= 1,
    bySource: !!summary.bySource[src],
  };

  return NextResponse.json({ ok: true, ...out });
}
