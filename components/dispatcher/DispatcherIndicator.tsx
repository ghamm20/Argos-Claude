// components/dispatcher/DispatcherIndicator.tsx
//
// Phase 11 Dispatcher (2026-05-31) — HUD "Dispatcher" row.
//
// Self-polling: fetches /api/dispatch (GET) on mount and every 60s,
// showing the last event routed, the persona it went to, and the total
// event count. Visual shape mirrors the other HUD indicator rows.
//
//   —                        no events yet
//   [security]→Bart  ·3      last event type → persona, count
//   ⚠ [ops]→Bobby  ·7        last result actionable (accent)

"use client";

import { useEffect, useState } from "react";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";

interface DispatcherStatus {
  lastEventAt: string | null;
  lastType: string | null;
  lastPersona: PersonaId | null;
  lastStatus: "ok" | "actionable" | "error" | null;
  count: number;
}

export function DispatcherIndicator() {
  const [d, setD] = useState<DispatcherStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/dispatch", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as DispatcherStatus;
        if (alive) setD(j);
      } catch {
        /* keep last value */
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
  let title = "Event dispatcher — last routed event";

  if (d) {
    if (!d.lastType || d.count === 0) {
      value = "—";
      title = "Dispatcher idle — no events routed yet";
    } else {
      const p = d.lastPersona ? PERSONA_BY_ID[d.lastPersona] : null;
      const pname = p?.name?.split(" ")[0] ?? d.lastPersona ?? "?";
      const mark = d.lastStatus === "actionable" ? "⚠ " : d.lastStatus === "error" ? "✕ " : "";
      value = `${mark}[${d.lastType}]→${pname} ·${d.count}`;
      color =
        d.lastStatus === "actionable"
          ? "#f59e0b"
          : d.lastStatus === "error"
            ? "#ef4444"
            : p?.accentColor ?? "#00ff9d";
      title = `Last: ${d.lastType} → ${p?.name ?? d.lastPersona} (${d.lastStatus}) at ${d.lastEventAt ?? "?"}. ${d.count} event(s) total.`;
    }
  }

  return (
    <div
      className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0"
      title={title}
    >
      <span className="uppercase tracking-[0.16em] text-neutral-500">
        Dispatcher
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
