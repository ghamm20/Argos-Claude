"use client";

// components/web/SourcesPane.tsx
//
// Web Capability TIER 3 (2026-06-02) — the Tool & Source dashboard. Shows the
// full tool roster (all 35) with governance, and live web-source activity from
// the audit/cache/rate stats: calls, cache-hit rate, errors-24h, rate budget.
// Each web source has an enforced per-session disable toggle.

import { useCallback, useEffect, useState } from "react";
import { Globe, RefreshCw, Power, Wrench } from "lucide-react";

interface ToolSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  dangerous: boolean;
  requiresApproval: boolean;
}
interface RateRow { source: string; tokens: number; burst: number; requestsPerMinute: number; }
interface BySource { calls: number; errors: number; cacheHits: number; avgLatencyMs: number; }
interface WebStats {
  cache: { entries: number; sizeBytes: number; hitRate: number; oldestAt: string | null };
  rate: RateRow[];
  audit: { total: number; callsToday: number; cacheHitRate: number; errors24h: number; bySource: Record<string, BySource> };
}

export function SourcesPane() {
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [stats, setStats] = useState<WebStats | null>(null);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [t, s, d] = await Promise.all([
        fetch("/api/tools/list", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/web/stats", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/web/disabled", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (t?.tools) setTools(t.tools);
      if (s?.cache) setStats(s);
      if (Array.isArray(d?.disabled)) setDisabled(d.disabled);
    } catch {
      /* offline */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => clearInterval(iv);
  }, [load]);

  const toggle = useCallback(async (source: string, next: boolean) => {
    setDisabled((prev) => (next ? [...new Set([...prev, source])] : prev.filter((s) => s !== source)));
    try {
      await fetch("/api/web/disabled", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, disabled: next }),
      });
    } catch {
      void load();
    }
  }, [load]);

  const webTools = tools.filter((t) => t.category === "web");
  const otherTools = tools.filter((t) => t.category !== "web");
  const sources = stats?.rate ?? [];

  return (
    <section className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-10 pt-6 pb-3 border-b border-neutral-800/60 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-[20px] font-semibold tracking-wide text-neutral-200">
            <Globe size={18} strokeWidth={1.5} className="text-neutral-500" />
            Tool Sources
          </div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mt-1">
            {tools.length} tools · {webTools.length} web sources · per-source kill switch
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 text-[11px] text-neutral-400 hover:text-neutral-200 border border-neutral-700 rounded-md px-2.5 py-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-10 py-6 space-y-8">
        {/* Web source activity */}
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-neutral-500 mb-3">Web Source Activity</div>
          {stats && (
            <div className="flex flex-wrap gap-3 mb-4 text-[11px]">
              <Stat label="Calls today" value={String(stats.audit.callsToday)} />
              <Stat label="Cache hit rate" value={`${Math.round((stats.audit.cacheHitRate || 0) * 100)}%`} />
              <Stat label="Errors 24h" value={String(stats.audit.errors24h)} danger={stats.audit.errors24h > 0} />
              <Stat label="Cache entries" value={String(stats.cache.entries)} />
              <Stat label="Cache size" value={`${(stats.cache.sizeBytes / 1024).toFixed(0)} KB`} />
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {sources.map((row) => {
              const a = stats?.audit.bySource[row.source];
              const off = disabled.includes(row.source);
              return (
                <div key={row.source} className={"rounded-md border px-3 py-2 " + (off ? "border-red-800/50 bg-red-950/10" : "border-neutral-800/70 bg-neutral-950/40")}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[12px] text-neutral-200">{row.source}</span>
                    <button
                      type="button"
                      onClick={() => void toggle(row.source, !off)}
                      title={off ? "Enable source" : "Disable source"}
                      className={"inline-flex items-center gap-1 text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 border " + (off ? "border-red-700/60 text-red-400" : "border-emerald-700/50 text-emerald-400 hover:bg-emerald-600/10")}
                    >
                      <Power className="h-3 w-3" /> {off ? "Disabled" : "Enabled"}
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-neutral-500">
                    <span>calls {a?.calls ?? 0}</span>
                    <span>cache {a?.cacheHits ?? 0}</span>
                    <span className={a && a.errors > 0 ? "text-red-400" : ""}>err {a?.errors ?? 0}</span>
                    <span>avg {a?.avgLatencyMs ?? 0}ms</span>
                    <span>budget {row.tokens}/{row.burst} · {row.requestsPerMinute}/min</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Full tool roster */}
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-neutral-500 mb-3">Web Tools ({webTools.length})</div>
          <ToolGrid tools={webTools} />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-neutral-500 mb-3">Other Tools ({otherTools.length})</div>
          <ToolGrid tools={otherTools} />
        </div>

        {loading && <div className="text-[12px] text-neutral-500">Loading…</div>}
      </div>
    </section>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-md border border-neutral-800/70 bg-black/30 px-3 py-1.5">
      <span className="text-neutral-500 uppercase tracking-[0.14em] text-[9px] block">{label}</span>
      <span className={"font-mono text-[14px] " + (danger ? "text-red-400" : "text-neutral-200")}>{value}</span>
    </div>
  );
}

function ToolGrid({ tools }: { tools: ToolSummary[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {tools.map((t) => (
        <div key={t.id} className="rounded-md border border-neutral-800/70 bg-neutral-950/40 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-neutral-200">
              <Wrench className="h-3 w-3 text-neutral-600" /> {t.id}
            </span>
            <span
              className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border"
              style={{
                borderColor: t.requiresApproval ? "rgba(234,179,8,0.4)" : "rgba(16,185,129,0.4)",
                color: t.requiresApproval ? "#eab308" : "#10b981",
              }}
            >
              {t.requiresApproval ? "Approval" : "Safe"}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-neutral-500 leading-snug">{t.description}</div>
        </div>
      ))}
    </div>
  );
}
