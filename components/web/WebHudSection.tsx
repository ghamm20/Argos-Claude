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

export function WebHudSection() {
  const [s, setS] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/web/stats", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as Stats;
        if (!cancelled) setS(j);
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
        {/* v2.3.8 doctrine — a non-zero count means the model claimed tool use
            that did not occur. Red + bold; this is operator-critical. */}
        <div className="flex items-center justify-between text-[11px] py-1.5">
          <span className="uppercase tracking-[0.16em]" style={{ color: integrity > 0 ? "#ef4444" : "#737373" }}>Integrity violations</span>
          <span className="font-mono text-[11px] font-bold" style={{ color: integrity > 0 ? "#ef4444" : "#a3a3a3" }}>{integrity}</span>
        </div>
      </div>
    </div>
  );
}
