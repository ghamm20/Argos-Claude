"use client";

import { useEffect, useState } from "react";
import { Cpu, Zap, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useArgos, AVAILABLE_MODELS } from "@/lib/store";
import type { HardwareProfile } from "@/lib/hardware";

const MODEL_LABELS: Record<string, { name: string; size: string; note: string }> = {
  "llama3.1:8b-instruct-q4_K_M": {
    name: "Llama 3.1 — 8B Instruct",
    size: "4.9 GB · Q4_K_M",
    note: "Full quality. Needs ≥6 GB VRAM (NVIDIA) or 16 GB unified (Apple Silicon).",
  },
  "qwen2.5:3b-instruct-q4_K_M": {
    name: "Qwen 2.5 — 3B Instruct",
    size: "1.9 GB · Q4_K_M",
    note: "Compact. Runs comfortably on CPU or low-VRAM GPU.",
  },
};

function modeBadge(mode: HardwareProfile["mode"]) {
  if (mode === "gpu")
    return { label: "GPU", icon: Zap, color: "#10b981" };
  if (mode === "metal")
    return { label: "Metal", icon: Zap, color: "#3b82f6" };
  return { label: "CPU", icon: Cpu, color: "#737373" };
}

export function ModelSection() {
  const currentModel = useArgos((s) => s.currentModel);
  const setModel = useArgos((s) => s.setModel);

  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [hwError, setHwError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const r = await fetch("/api/hardware", { cache: "no-store" });
        if (!r.ok) {
          setHwError(`HTTP ${r.status}`);
          return;
        }
        const j = (await r.json()) as HardwareProfile;
        if (!cancel) setHw(j);
      } catch (e) {
        if (!cancel) setHwError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const recommended = hw?.recommendedModel ?? null;
  const badge = hw ? modeBadge(hw.mode) : null;

  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">Model</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Active inference model. Hardware-aware recommendation below.
      </p>

      <div
        data-testid="hardware-card"
        className="rounded-md border border-neutral-800 bg-black/30 px-4 py-3 mb-6"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
            Hardware
          </div>
          {badge && (
            <span
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded-sm border"
              style={{ borderColor: badge.color, color: badge.color }}
            >
              <badge.icon size={10} strokeWidth={2} />
              {badge.label}
            </span>
          )}
        </div>
        {hw && (
          <>
            <div className="text-[13px] text-neutral-200 font-mono">
              {hw.gpuName ?? hw.cpuModel}
            </div>
            <div className="text-[11px] text-neutral-500 mt-1">
              {hw.vramGB > 0 ? `${hw.vramGB} GB VRAM · ` : ""}
              {hw.totalRamGB} GB RAM · {hw.cpuCores} cores · {hw.platform}
            </div>
            <div className="text-[12px] text-neutral-300 mt-3 leading-relaxed">
              {hw.reason}
            </div>
          </>
        )}
        {hwError && (
          <div className="text-[12px] text-red-400">
            Hardware detection failed: {hwError}
          </div>
        )}
        {!hw && !hwError && (
          <div className="text-[12px] text-neutral-500">Detecting…</div>
        )}
      </div>

      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mb-2">
        Active model
      </div>
      <div className="space-y-2">
        {AVAILABLE_MODELS.map((m) => {
          const meta = MODEL_LABELS[m];
          const selected = m === currentModel;
          const isRecommended = m === recommended;
          const isOverride = selected && !!recommended && !isRecommended;
          return (
            <label
              key={m}
              data-testid={`model-option-${m}`}
              className="block rounded-md border px-3 py-2.5 cursor-pointer transition-colors"
              style={{
                borderColor: selected ? "#a3a3a3" : "rgba(64,64,64,0.6)",
                background: selected
                  ? "rgba(255,255,255,0.04)"
                  : "rgba(10,10,10,0.4)",
              }}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="model"
                  value={m}
                  checked={selected}
                  onChange={() => setModel(m)}
                  className="mt-1 accent-neutral-300"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium text-neutral-100">
                      {meta?.name ?? m}
                    </span>
                    {isRecommended && (
                      <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.18em] text-emerald-400 border border-emerald-500/40 rounded-sm px-1.5 py-0.5">
                        <CheckCircle2 size={9} strokeWidth={2} />
                        Auto-detected
                      </span>
                    )}
                    {isOverride && (
                      <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.18em] text-amber-400 border border-amber-500/40 rounded-sm px-1.5 py-0.5">
                        <AlertTriangle size={9} strokeWidth={2} />
                        Override
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
                    {m} · {meta?.size ?? ""}
                  </div>
                  {meta?.note && (
                    <div className="text-[11px] text-neutral-500 mt-1.5 leading-relaxed">
                      {meta.note}
                    </div>
                  )}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-600 mt-4">
        Changes apply to the next chat turn. Existing context is preserved.
      </div>
    </div>
  );
}
