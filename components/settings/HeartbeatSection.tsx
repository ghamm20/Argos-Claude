// components/settings/HeartbeatSection.tsx
//
// Phase 10 Heartbeat (2026-05-31) — Settings panel for the ambient
// autonomous dispatcher. Enable/disable toggle + interval, a live
// status readout (last tick, result, next tick, counts), and a
// "Run now" button that fires a manual tick for testing.
//
// Reads settings via GET /api/settings (heartbeat.{enabled,
// intervalMinutes}) and the live status via GET /api/heartbeat/status.
// Writes the toggle/interval via POST /api/settings.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, Play, AlertCircle } from "lucide-react";

interface HeartbeatStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  last: { status: string; reason: string; triageSnippet: string | null; alert: { title: string; fired: boolean } | null } | null;
  counts: { ticks: number; ok: number; actionable: number; skipped: number; errors: number; alertsFired: number };
  checklistFile: string | null;
}

export function HeartbeatSection() {
  const [status, setStatus] = useState<HeartbeatStatus | null>(null);
  const [interval, setIntervalMin] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/heartbeat/status", { cache: "no-store" });
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as HeartbeatStatus;
      setStatus(j);
      setIntervalMin(j.intervalMinutes || 30);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchSettings = useCallback(
    async (heartbeat: { enabled?: boolean; intervalMinutes?: number }) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ heartbeat }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `HTTP ${r.status}`);
          return;
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const runNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/heartbeat/trigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const j = (await r.json()) as { ok: boolean; result?: { status: string }; error?: string };
      if (!j.ok) setError(j.error ?? "trigger failed");
      else setLastRun(j.result?.status ?? "(ran)");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const enabled = status?.enabled ?? false;

  return (
    <div>
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-[15px] font-medium text-neutral-100 flex items-center gap-2">
          <Activity size={15} strokeWidth={1.8} className="text-neutral-400" />
          Heartbeat
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh status"
          className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 hover:text-neutral-300 inline-flex items-center gap-1"
        >
          <RefreshCw size={11} strokeWidth={2} />
          Refresh
        </button>
      </div>
      <p className="text-[12px] text-neutral-500 mb-6">
        Ambient autonomous tick. On each interval ARGOS reads{" "}
        <span className="font-mono">$ARGOS_ROOT/HEARTBEAT.md</span>, asks the
        triage model (Bobby) if anything needs attention, and fires a Pushover
        alert only when something is actionable. Silent otherwise.
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-300 inline-flex items-center gap-2">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      <div className="space-y-4">
        {/* Enable toggle */}
        <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-black/30 px-4 py-3">
          <div>
            <div className="text-[13px] text-neutral-100">Enable heartbeat</div>
            <div className="text-[11px] text-neutral-500">
              {enabled ? "Running in the background." : "Off — no ticks fire."}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void patchSettings({ enabled: !enabled })}
            className="text-[11px] uppercase tracking-[0.18em] px-3 py-1.5 rounded-sm border transition-colors disabled:opacity-50"
            style={{
              borderColor: enabled ? "rgba(16,185,129,0.5)" : "rgba(120,120,120,0.4)",
              color: enabled ? "#10b981" : "#a3a3a3",
            }}
          >
            {enabled ? "On" : "Off"}
          </button>
        </div>

        {/* Interval */}
        <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-black/30 px-4 py-3">
          <div className="text-[13px] text-neutral-100">Interval (minutes)</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={interval}
              onChange={(e) => setIntervalMin(parseInt(e.target.value || "30", 10))}
              className="w-20 bg-black/40 border border-neutral-700 rounded-sm px-2 py-1 text-[12px] text-neutral-200 text-right font-mono"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void patchSettings({ intervalMinutes: interval })}
              className="text-[11px] uppercase tracking-[0.18em] px-3 py-1.5 rounded-sm border border-neutral-700 text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>

        {/* Run now */}
        <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-black/30 px-4 py-3">
          <div>
            <div className="text-[13px] text-neutral-100">Run a tick now</div>
            <div className="text-[11px] text-neutral-500">
              Manual trigger (works even while disabled).
              {lastRun && <span className="text-neutral-400"> Last: {lastRun}</span>}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runNow()}
            className="text-[11px] uppercase tracking-[0.18em] px-3 py-1.5 rounded-sm border border-neutral-700 text-neutral-300 hover:border-neutral-500 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Play size={11} strokeWidth={2} /> Run now
          </button>
        </div>

        {/* Status readout */}
        {status && (
          <div className="rounded-md border border-neutral-800 bg-black/20 px-4 py-3 text-[11px] text-neutral-500 space-y-1">
            <div>Running: <span className="font-mono text-neutral-300">{String(status.running)}</span> · interval <span className="font-mono text-neutral-300">{status.intervalMinutes}m</span></div>
            <div>Last tick: <span className="font-mono text-neutral-300">{status.lastTickAt ?? "—"}</span></div>
            <div>Last result: <span className="font-mono text-neutral-300">{status.last?.status ?? "—"}</span>{status.last?.reason ? ` (${status.last.reason})` : ""}</div>
            <div>Next tick: <span className="font-mono text-neutral-300">{status.nextTickAt ?? "—"}</span></div>
            <div>Counts: <span className="font-mono text-neutral-300">ticks {status.counts.ticks} · ok {status.counts.ok} · action {status.counts.actionable} · skip {status.counts.skipped} · err {status.counts.errors} · alerts {status.counts.alertsFired}</span></div>
            <div className="truncate" title={status.checklistFile ?? ""}>Checklist: <span className="font-mono text-neutral-400">{status.checklistFile ?? "—"}</span></div>
          </div>
        )}
      </div>
    </div>
  );
}
