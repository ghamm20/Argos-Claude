// components/research/ResearchIndicator.tsx
//
// Phase 10 — HUD Research row. Reads researchState from Zustand
// (populated by ChatPane consuming the chat stream's research
// event) and renders one of:
//
//   OFF             — neutral, last turn had no research
//   LIVE — {intent} — teal, fresh research served this turn
//   CACHED — {age}  — amber, served from cache
//   FAILED          — red, pipeline ran but quality=FAILED
//
// Visual shape mirrors the existing HUD Row inline so styling stays
// stable if HUD.tsx evolves.

"use client";

import { useArgos } from "@/lib/store";

function ageMinutes(iso: string | null): number {
  if (!iso) return -1;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

export function ResearchIndicator() {
  const rs = useArgos((s) => s.researchState);

  let value: React.ReactNode = "OFF";
  let color: string | undefined;
  let title = "No research attempted this turn";

  if (rs.state === "LIVE") {
    value = `LIVE — ${rs.intent ?? "?"}`;
    color = "#00ff9d";
    title = `Live research · quality ${rs.quality ?? "?"} · conf ${rs.confidence?.toFixed(2) ?? "?"}`;
  } else if (rs.state === "CACHED") {
    const ageM = ageMinutes(rs.cachedAt);
    const ageLabel = ageM >= 0 ? `${ageM}m` : "?";
    value = `CACHED — ${ageLabel}`;
    color = "#f59e0b";
    title = `Served from cache · intent ${rs.intent ?? "?"} · generated ${rs.cachedAt ?? "?"}`;
  } else if (rs.state === "FAILED") {
    value = "FAILED";
    color = "#ef4444";
    title = "Research pipeline ran but no usable result";
  }

  return (
    <div
      className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0"
      title={title}
    >
      <span className="uppercase tracking-[0.16em] text-neutral-500">
        Research
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
