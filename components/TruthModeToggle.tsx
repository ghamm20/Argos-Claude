"use client";

import { useArgos } from "@/lib/store";
import { ShieldCheck } from "lucide-react";

export function TruthModeToggle() {
  const truthMode = useArgos((s) => s.truthMode);
  const setTruthMode = useArgos((s) => s.setTruthMode);
  const accent = useArgos((s) => s.accentColor());

  return (
    <button
      type="button"
      role="switch"
      aria-checked={truthMode}
      data-testid="truth-mode-toggle"
      onClick={() => setTruthMode(!truthMode)}
      title="Surfaces uncertainty, enforces citation when sources exist, hedges low-confidence claims"
      className="w-full flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-[11px] transition-colors"
      style={{
        borderColor: truthMode ? accent : "rgba(64,64,64,0.6)",
        background: truthMode ? `${accent}14` : "rgba(10,10,10,0.4)",
        color: truthMode ? accent : "#a3a3a3",
      }}
    >
      <span className="flex items-center gap-2 uppercase tracking-[0.18em]">
        <ShieldCheck size={12} strokeWidth={1.75} />
        Truth Mode
      </span>
      <span
        className="inline-flex h-3.5 w-6 rounded-full border items-center transition-colors"
        style={{
          borderColor: truthMode ? accent : "rgba(82,82,82,0.6)",
          background: truthMode ? `${accent}33` : "transparent",
          justifyContent: truthMode ? "flex-end" : "flex-start",
          padding: "1px",
        }}
      >
        <span
          className="block h-2.5 w-2.5 rounded-full"
          style={{ background: truthMode ? accent : "#525252" }}
        />
      </span>
    </button>
  );
}
