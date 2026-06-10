"use client";

// components/web/WebHudSection.tsx
//
// Web Capability TIER 3 (2026-06-02) — HUD "WEB CALLS" block. Polls
// /api/web/stats every 20s; shows calls-today + cache-hit % + errors-24h.
// Self-contained so it doesn't perturb the main HUD's hook order.

import { useEffect, useState } from "react";

interface Stats {
  audit?: { callsToday?: number; cacheHitRate?: number; errors24h?: number };
  cache?: { entries?: number };
  integrityViolations?: number;
}

// Stage 5 / v2.4.3 — rolling integrity measurement (from /api/integrity/metrics).
interface IntegrityMetrics {
  runs: number;
  lastAt: string | null;
  lastCatchRate: number | null;
  catchRate7d: number | null;
  lastMissedIds: string[];
  anyMissLastRun: boolean;
}

export function WebHudSection() {
  const [s, setS] = useState<Stats | null>(null);
  const [im, setIm] = useState<IntegrityMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [r, ri] = await Promise.all([
          fetch("/api/web/stats", { cache: "no-store" }),
          fetch("/api/integrity/metrics", { cache: "no-store" }),
        ]);
        if (r.ok && !cancelled) setS((await r.json()) as Stats);
        if (ri.ok && !cancelled) setIm((await ri.json()) as IntegrityMetrics);
      } catch {
        /* offline */
      }
    };
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const calls = s?.audit?.callsToday ?? 0;
  const hit = Math.round((s?.audit?.cacheHitRate ?? 0) * 100);
  const errs = s?.audit?.errors24h ?? 0;
  const integrity = s?.integrityViolations ?? 0;
  const catchPct = im?.catchRate7d != null ? Math.round(im.catchRate7d * 100) : null;
  const missCount = im?.lastMissedIds?.length ?? 0;
  const lastRun = im?.lastAt ? new Date(im.lastAt).toLocaleString() : "never";

  return (
    <div className="mb-4">
      <div className="text-[9px] uppercase tracking-[0.22em] text-neutral-600 mb-1.5">Web</div>
      <div className="rounded-md border border-neutral-800/70 bg-black/30 px-3 py-2">
        <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50">
          <span className="uppercase tracking-[0.16em] text-neutral-500">Calls today</span>
          <span className="font-mono text-[11px] text-neutral-200">{calls.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50">
          <span className="uppercase tracking-[0.16em] text-neutral-500">Cache hit</span>
          <span className="font-mono text-[11px]" style={{ color: hit >= 30 ? "#10b981" : "#a3a3a3" }}>{hit}%</span>
        </div>
        <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50">
          <span className="uppercase tracking-[0.16em] text-neutral-500">Errors 24h</span>
          <span className="font-mono text-[11px]" style={{ color: errs > 0 ? "#ef4444" : "#a3a3a3" }}>{errs}</span>
        </div>
        {/* Stage 5 / v2.4.3 — integrity MEASUREMENT (rolling, from the
            adversarial stress corpus) replaces a bare assertion. Catch rate is
            the 7-day mean; a non-zero last-run miss count red-flags a guard gap.
            The live-turn violation count stays as a secondary signal. */}
        <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50">
          <span className="uppercase tracking-[0.16em] text-neutral-500" title={`last stress run: ${lastRun} · ${im?.runs ?? 0} runs`}>Catch rate 7d</span>
          <span className="font-mono text-[11px]" style={{ color: catchPct == null ? "#737373" : catchPct >= 90 ? "#10b981" : catchPct >= 75 ? "#eab308" : "#ef4444" }}>
            {catchPct == null ? "—" : `${catchPct}%`}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50">
          <span className="uppercase tracking-[0.16em]" style={{ color: missCount > 0 ? "#ef4444" : "#737373" }} title={missCount > 0 ? `missed: ${im?.lastMissedIds?.join(", ")}` : "no guard misses in the last run"}>Guard misses</span>
          <span className="font-mono text-[11px] font-bold" style={{ color: missCount > 0 ? "#ef4444" : "#a3a3a3" }}>{missCount}</span>
        </div>
        <div className="flex items-center justify-between text-[11px] py-1.5">
          <span className="uppercase tracking-[0.16em]" style={{ color: integrity > 0 ? "#ef4444" : "#737373" }}>Live violations</span>
          <span className="font-mono text-[11px] font-bold" style={{ color: integrity > 0 ? "#ef4444" : "#a3a3a3" }}>{integrity}</span>
        </div>
      </div>
    </div>
  );
}
