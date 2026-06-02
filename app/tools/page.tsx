// app/tools/page.tsx
//
// Phase 10 — operator-facing Tools page. Replaces the v2 stub with a
// functional Research section: cache status, per-stream Run-Now
// buttons, last-run summary. Dark-theme functional UI; no new deps.

"use client";

import { useCallback, useEffect, useState } from "react";

type Quality = "SUFFICIENT" | "PARTIAL" | "FAILED" | "CONFLICTED";

interface CacheStatusEntry {
  cacheKey: string;
  intent: string;
  expiresAt: string;
  generatedAt: string;
  quality: Quality;
  confidenceScore: number;
  resultCount: number;
  sizeBytes: number;
}

interface CacheStatus {
  totalEntries: number;
  totalSizeBytes: number;
  entries: CacheStatusEntry[];
}

interface RunReport {
  id: string;
  intent: string;
  quality: Quality;
  confidenceScore: number;
  generatedAt: string;
  summary: string;
  findings: string[];
  citations: string[];
  conflicts: string[];
  cachedAt?: string;
  iteration: number;
}

const STREAM_BUTTONS: Array<{ key: string; label: string }> = [
  { key: "weather_atl", label: "Weather · Atlanta" },
  { key: "weather_orl", label: "Weather · Orlando" },
  { key: "news_atl", label: "News · Atlanta" },
  { key: "news_orl", label: "News · Orlando" },
  { key: "ai_updates", label: "AI Updates" },
  { key: "arxiv", label: "arXiv Papers" }, // Phase 11
];

interface SchedulerStatus {
  running: boolean;
  startedAt: string | null;
  activeStreams: Array<{ stream: string; intervalMinutes: number }>;
  state: {
    startedAt: string | null;
    lastFiredAt: Record<string, string>;
    runCount: Record<string, number>;
    skippedInFlight: Record<string, number>;
    failureCount: Record<string, number>;
  };
}

// Tools Phase (2026-06-02) — the 18-tool governed suite.
interface SuiteTool {
  id: string;
  name: string;
  description: string;
  category: string;
  dangerous: boolean;
  requiresApproval: boolean;
  requiresRestore: boolean;
  reversible: boolean;
  executions: number;
  lastUsed: string | null;
  lastOk: boolean | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  web: "Web",
  document: "Documents",
  comms: "Comms",
  security: "Security",
  system: "System",
};

function shortIso(s: string): string {
  return s ? s.replace("T", " ").slice(0, 16) : "";
}

function ageMinutes(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function qualityColor(q: Quality): string {
  switch (q) {
    case "SUFFICIENT": return "#10b981";
    case "PARTIAL": return "#eab308";
    case "FAILED": return "#ef4444";
    case "CONFLICTED": return "#f59e0b";
    default: return "#737373";
  }
}

export default function ToolsPage() {
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<RunReport | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Phase 11 — scheduler + alerts state.
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [pushoverConfigured, setPushoverConfigured] = useState<boolean | null>(null);
  // Tools Phase — the 18 governed tools.
  const [suite, setSuite] = useState<SuiteTool[] | null>(null);

  const refreshCache = useCallback(async () => {
    try {
      const r = await fetch("/api/research/cache", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as CacheStatus;
      setCache(j);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshScheduler = useCallback(async () => {
    try {
      const r = await fetch("/api/research/schedule", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as SchedulerStatus;
      setScheduler(j);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshPushover = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        operatorPushoverUserKey?: string | null;
        operatorPushoverApiToken?: string | null;
      };
      setPushoverConfigured(
        typeof j.operatorPushoverUserKey === "string" &&
          j.operatorPushoverUserKey.length > 0 &&
          typeof j.operatorPushoverApiToken === "string" &&
          j.operatorPushoverApiToken.length > 0
      );
    } catch {
      setPushoverConfigured(false);
    }
  }, []);

  const refreshSuite = useCallback(async () => {
    try {
      const r = await fetch("/api/tools/suite", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { tools: SuiteTool[] };
      setSuite(j.tools);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshCache();
    void refreshScheduler();
    void refreshPushover();
    void refreshSuite();
  }, [refreshCache, refreshScheduler, refreshPushover, refreshSuite]);

  const toggleScheduler = useCallback(
    async (action: "start" | "stop") => {
      setBusy(true);
      try {
        // First flip the persisted enabled flag so the start respects
        // it. POST /api/settings researchSchedule.enabled.
        await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            researchSchedule: { enabled: action === "start" },
          }),
        });
        const r = await fetch("/api/research/schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (r.ok) {
          setMsg(action === "start" ? "Scheduler started." : "Scheduler stopped.");
        } else {
          setMsg(`scheduler ${action} HTTP ${r.status}`);
        }
        await refreshScheduler();
        window.setTimeout(() => setMsg(null), 2500);
      } finally {
        setBusy(false);
      }
    },
    [refreshScheduler]
  );

  const sendTestAlert = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/research/alert/test", { method: "POST" });
      const j = (await r.json()) as { ok?: boolean; sent?: boolean; reason?: string };
      setMsg(
        j.sent
          ? "Test alert dispatched."
          : `Alert not sent: ${j.reason ?? "unknown reason"}`
      );
      window.setTimeout(() => setMsg(null), 4000);
    } finally {
      setBusy(false);
    }
  }, []);

  const clearCache = useCallback(async () => {
    if (!window.confirm("Clear all cached research reports?")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/research/cache", { method: "DELETE" });
      if (r.ok) {
        const j = (await r.json()) as { removed: number };
        setMsg(`Cleared ${j.removed} entr${j.removed === 1 ? "y" : "ies"}.`);
        window.setTimeout(() => setMsg(null), 2500);
        await refreshCache();
      } else {
        setMsg(`Clear failed: HTTP ${r.status}`);
      }
    } finally {
      setBusy(false);
    }
  }, [refreshCache]);

  const runStream = useCallback(
    async (streamKey: string, label: string) => {
      setActiveRun(streamKey);
      setBusy(true);
      setMsg(null);
      try {
        const r = await fetch("/api/research/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stream: streamKey }),
        });
        const j = (await r.json()) as { ok?: boolean; report?: RunReport; error?: string };
        if (j.ok && j.report) {
          setLastReport(j.report);
          setMsg(`${label}: ${j.report.quality} (${j.report.confidenceScore.toFixed(2)})`);
          await refreshCache();
        } else {
          setMsg(`${label} failed: ${j.error ?? "unknown error"}`);
        }
      } catch (e) {
        setMsg(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
        setActiveRun(null);
      }
    },
    [refreshCache]
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 px-8 py-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-[20px] font-medium tracking-tight">Tools</h1>
          <p className="text-[12px] text-neutral-500 mt-1">
            Bartimaeus&apos;s tool suite (governed: disclose · approve · restore ·
            audit) plus the Phase 10 research pipeline.
          </p>
        </header>

        {/* Tools Phase — the 18 governed tools */}
        <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-neutral-100">
              Tool suite{" "}
              <span className="text-neutral-500 text-[11px]">
                {suite ? `(${suite.length})` : ""}
              </span>
            </h2>
            <button
              type="button"
              onClick={() => void refreshSuite()}
              className="text-[11px] text-neutral-400 hover:text-neutral-200"
            >
              Reload
            </button>
          </div>
          {suite === null ? (
            <div className="text-[12px] text-neutral-500">Loading…</div>
          ) : (
            ["web", "document", "comms", "security", "system"].map((cat) => {
              const tools = suite.filter((t) => t.category === cat);
              if (tools.length === 0) return null;
              return (
                <div key={cat} className="mb-3 last:mb-0">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-600 mb-1">
                    {CATEGORY_LABEL[cat] ?? cat}
                  </div>
                  <ul className="space-y-1">
                    {tools.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-center gap-2 px-2 py-1 rounded border border-neutral-800/60 text-[12px]"
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full shrink-0"
                          style={{
                            background: t.dangerous ? "#f59e0b" : "#10b981",
                          }}
                          title={t.dangerous ? "dangerous (approval required)" : "safe"}
                        />
                        <span className="font-mono text-[11px] text-neutral-300 w-40 shrink-0 truncate">
                          {t.id}
                        </span>
                        <span className="text-neutral-400 flex-1 truncate">
                          {t.description}
                        </span>
                        {t.requiresApproval && (
                          <span className="text-[9px] uppercase tracking-wider text-amber-400">
                            approval
                          </span>
                        )}
                        {t.requiresRestore && (
                          <span className="text-[9px] uppercase tracking-wider text-blue-400">
                            restore
                          </span>
                        )}
                        <span
                          className="text-[10px] text-neutral-500 w-24 text-right shrink-0"
                          title={t.lastUsed ? `last used ${t.lastUsed}` : "never used"}
                        >
                          {t.executions > 0
                            ? `${t.executions}× · ${t.lastUsed ? shortIso(t.lastUsed) : ""}`
                            : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>

        {/* Research streams */}
        <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-neutral-100">Research streams</h2>
            {msg && <span className="text-[11px] text-neutral-400">{msg}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {STREAM_BUTTONS.map((b) => (
              <button
                key={b.key}
                type="button"
                disabled={busy}
                onClick={() => void runStream(b.key, b.label)}
                className="px-3 py-1.5 rounded text-[12px] bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
              >
                {activeRun === b.key ? "Running…" : `▶ ${b.label}`}
              </button>
            ))}
          </div>
        </section>

        {/* Last report */}
        {lastReport && (
          <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-[14px] font-medium text-neutral-100">Last run</h2>
              <div className="flex items-center gap-3 text-[11px]">
                <span style={{ color: qualityColor(lastReport.quality) }}>
                  {lastReport.quality}
                </span>
                <span className="text-neutral-500">
                  conf {lastReport.confidenceScore.toFixed(2)}
                </span>
                <span className="text-neutral-500">
                  iter {lastReport.iteration}
                </span>
                <span className="text-neutral-500">
                  {shortIso(lastReport.generatedAt)}
                </span>
              </div>
            </div>
            <div className="text-[12px] text-neutral-200 mb-2">
              {lastReport.summary}
            </div>
            {lastReport.findings.length > 0 && (
              <div className="mb-2">
                <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-1">Findings</div>
                <ul className="space-y-1 text-[12px] text-neutral-300">
                  {lastReport.findings.map((f, i) => (
                    <li key={i}>· {f}</li>
                  ))}
                </ul>
              </div>
            )}
            {lastReport.conflicts.length > 0 && (
              <div className="mb-2">
                <div className="text-[11px] uppercase tracking-[0.18em] text-amber-400 mb-1">Conflicts</div>
                <ul className="space-y-1 text-[12px] text-amber-300">
                  {lastReport.conflicts.map((c, i) => (
                    <li key={i}>· {c}</li>
                  ))}
                </ul>
              </div>
            )}
            {lastReport.citations.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-1">Citations</div>
                <ul className="space-y-1 text-[11px] text-neutral-500 font-mono">
                  {lastReport.citations.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Cache status */}
        <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-neutral-100">Cache</h2>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void refreshCache()}
                className="text-[11px] text-neutral-400 hover:text-neutral-200"
              >
                Reload
              </button>
              <button
                type="button"
                onClick={() => void clearCache()}
                disabled={busy || !cache || cache.totalEntries === 0}
                className="text-[11px] text-red-400 hover:text-red-200 disabled:opacity-50"
              >
                Clear cache
              </button>
            </div>
          </div>
          {cache === null ? (
            <div className="text-[12px] text-neutral-500">Loading…</div>
          ) : cache.totalEntries === 0 ? (
            <div className="text-[12px] text-neutral-500 italic">Empty.</div>
          ) : (
            <>
              <div className="text-[11px] text-neutral-500 mb-2">
                {cache.totalEntries} entr{cache.totalEntries === 1 ? "y" : "ies"} · {fmtBytes(cache.totalSizeBytes)} total
              </div>
              <ul className="space-y-1 text-[12px]">
                {cache.entries.map((e) => {
                  const expMin = ageMinutes(e.expiresAt);
                  const expiresInMin = -ageMinutes(e.expiresAt);
                  const remaining = -expiresInMin;
                  return (
                    <li
                      key={e.cacheKey}
                      className="flex items-center justify-between gap-3 px-2 py-1 rounded border border-neutral-800/60"
                    >
                      <span className="font-mono text-neutral-300 truncate flex-1" title={e.cacheKey}>
                        {e.cacheKey}
                      </span>
                      <span style={{ color: qualityColor(e.quality) }} className="text-[10px]">
                        {e.quality}
                      </span>
                      <span className="text-neutral-500 text-[10px]">
                        conf {e.confidenceScore.toFixed(2)}
                      </span>
                      <span className="text-neutral-500 text-[10px]">
                        {e.resultCount} hits
                      </span>
                      <span className="text-neutral-500 text-[10px]">
                        {fmtBytes(e.sizeBytes)}
                      </span>
                      <span className="text-neutral-500 text-[10px]" title={`expires ${e.expiresAt}`}>
                        {remaining > 0
                          ? `${remaining}m left`
                          : `expired ${expMin}m ago`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        {/* Phase 11 — Scheduler */}
        <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-neutral-100">
              Scheduler <span className="text-neutral-500 text-[11px]">(Phase 11)</span>
            </h2>
            <span className="text-[11px]" style={{ color: scheduler?.running ? "#00ff9d" : "#737373" }}>
              {scheduler?.running ? "RUNNING" : "STOPPED"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={() => void toggleScheduler("start")}
              disabled={busy || scheduler?.running === true}
              className="px-3 py-1.5 rounded text-[12px] bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
            >
              Start scheduler
            </button>
            <button
              type="button"
              onClick={() => void toggleScheduler("stop")}
              disabled={busy || scheduler?.running === false}
              className="px-3 py-1.5 rounded text-[12px] text-red-400 border border-red-700/60 hover:bg-red-900/20 disabled:opacity-50"
            >
              Stop scheduler
            </button>
            <button
              type="button"
              onClick={() => void refreshScheduler()}
              className="px-3 py-1.5 rounded text-[12px] text-neutral-400 border border-neutral-700/60 hover:bg-neutral-800/60"
            >
              Refresh
            </button>
          </div>
          {scheduler && scheduler.activeStreams.length > 0 && (
            <div className="mb-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-1">Active streams</div>
              <ul className="space-y-1 text-[11px] font-mono">
                {scheduler.activeStreams.map((s) => {
                  const last = scheduler.state.lastFiredAt[s.stream];
                  const runs = scheduler.state.runCount[s.stream] ?? 0;
                  const skipped = scheduler.state.skippedInFlight[s.stream] ?? 0;
                  const fails = scheduler.state.failureCount[s.stream] ?? 0;
                  return (
                    <li key={s.stream} className="flex flex-wrap gap-3 px-2 py-1 rounded border border-neutral-800/60">
                      <span className="text-neutral-300">{s.stream}</span>
                      <span className="text-neutral-500">every {s.intervalMinutes}m</span>
                      <span className="text-neutral-500">runs {runs}</span>
                      <span className="text-neutral-500">skipped {skipped}</span>
                      <span className="text-neutral-500">fails {fails}</span>
                      {last && <span className="text-neutral-500">last {shortIso(last)}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-neutral-600">
            Scheduler fires background research at configured intervals
            (set in <span className="font-mono">settings.researchSchedule</span>).
            Skips ticks while a chat is in-flight.
          </p>
        </section>

        {/* Phase 11 — Pushover alerts */}
        <section className="mb-8 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-neutral-100">
              Pushover alerts <span className="text-neutral-500 text-[11px]">(Phase 11)</span>
            </h2>
            <span className="text-[11px]" style={{ color: pushoverConfigured ? "#00ff9d" : "#f59e0b" }}>
              {pushoverConfigured === null
                ? "checking…"
                : pushoverConfigured
                  ? "CONFIGURED"
                  : "NOT CONFIGURED"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={() => void sendTestAlert()}
              disabled={busy || pushoverConfigured !== true}
              className="px-3 py-1.5 rounded text-[12px] bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
            >
              Send test alert
            </button>
            <button
              type="button"
              onClick={() => void refreshPushover()}
              className="px-3 py-1.5 rounded text-[12px] text-neutral-400 border border-neutral-700/60 hover:bg-neutral-800/60"
            >
              Refresh
            </button>
          </div>
          <p className="text-[11px] text-neutral-600">
            Set <span className="font-mono">operatorPushoverUserKey</span> +
            <span className="font-mono"> operatorPushoverApiToken</span> via
            <span className="font-mono"> /api/settings</span> POST.
            Alerts fire when a research report meets the criteria
            (quality SUFFICIENT + confidence ≥ threshold, OR watchlist keyword match).
          </p>
        </section>

        <p className="text-[11px] text-neutral-600">
          Cache TTLs: weather 30m · news 60m · AI updates 2h · arXiv 6h · general 3h.
          Daily key rollover at UTC midnight.
        </p>
      </div>
    </div>
  );
}
