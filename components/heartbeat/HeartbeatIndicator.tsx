// components/heartbeat/HeartbeatIndicator.tsx
//
// Phase 10 Heartbeat (2026-05-31) — HUD "Heartbeat" row.
//
// Self-polling: fetches /api/heartbeat/status on mount and every 60s
// (the heartbeat is a background server subsystem, not pushed via the
// chat stream, so the HUD polls it). Renders last tick time, last
// result, and the next scheduled tick. Visual shape mirrors the other
// HUD indicator rows.
//
//   OFF                      disabled
//   ON · —                   enabled, no tick yet
//   ok · 14:32 → 15:02       last result + last tick → next tick
//   ⚠ action · 14:32         actionable result (accent)

"use client";

import { useEffect, useState } from "react";

interface HeartbeatStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  last: { status: string } | null;
}

function hhmm(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function HeartbeatIndicator() {
  const [hb, setHb] = useState<HeartbeatStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/heartbeat/status", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as HeartbeatStatus;
        if (alive) setHb(j);
      } catch {
        /* network blip — keep last value */
      }
    };
    void poll();
    const id = setInterval(poll, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  let value: React.ReactNode = "…";
  let color: string | undefined;
  let title = "Heartbeat dispatcher status";

  if (hb) {
    if (!hb.enabled) {
      value = "OFF";
      title = "Heartbeat disabled — enable in Settings";
    } else {
      const last = hb.last?.status ?? null;
      const tick = hhmm(hb.lastTickAt);
      const next = hhmm(hb.nextTickAt);
      if (last === "actionable") {
        value = `⚠ action · ${tick}`;
        color = "#f59e0b";
        title = `Heartbeat flagged an action at ${tick}. Next ~${next}.`;
      } else if (last === "error") {
        value = `err · ${tick} → ${next}`;
        color = "#ef4444";
        title = `Last heartbeat tick errored at ${tick} (e.g. Ollama down). Next ~${next}.`;
      } else if (last) {
        value = `${last} · ${tick} → ${next}`;
        color = "#00ff9d";
        title = `Last tick ${last} at ${tick}. Next ~${next}. Interval ${hb.intervalMinutes}m.`;
      } else {
        value = `ON → ${next}`;
        color = "#00ff9d";
        title = `Heartbeat on (interval ${hb.intervalMinutes}m). No tick yet. Next ~${next}.`;
      }
    }
  }

  return (
    <div
      className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0"
      title={title}
    >
      <span className="uppercase tracking-[0.16em] text-neutral-500">
        Heartbeat
      </span>
      <span
        className="font-mono text-[11px] text-neutral-200 truncate max-w-[160px] text-right"
        style={color ? { color } : undefined}
      >
        {value}
      </span>
    </div>
  );
}
