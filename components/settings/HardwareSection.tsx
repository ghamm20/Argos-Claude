// components/settings/HardwareSection.tsx
//
// Phase 7 (2026-06-10) — the hardware capability panel. Shows the DETECTED GPU
// tier (the truth from nvidia-smi) and the operator Power-Mode override switch:
// auto / force-off / attempt-on. On a lean GPU, attempt-on returns an HONEST
// VRAM failure (never fakes Power Mode) and the gated feature list stays
// greyed + visibly labeled "Requires ≥24GB VRAM" — visible, not hidden.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { getSessionToken } from "@/lib/auth-client";

type OverrideMode = "auto" | "force-off" | "attempt-on";

interface PowerStatus {
  available: boolean;
  tier: string;
  vramGb: number;
  reason: string;
  enables: string[];
  override: OverrideMode;
  attemptFailed: boolean;
  error: string | null;
}

const bearer = (): Record<string, string> => {
  const t = getSessionToken();
  return t ? { authorization: `Bearer ${t}` } : {};
};

const MODES: Array<{ id: OverrideMode; label: string; hint: string }> = [
  { id: "auto", label: "Auto", hint: "Follow detection — Power Mode on iff an ample-tier GPU (≥24GB) is present." },
  { id: "force-off", label: "Force Off", hint: "Keep Power Mode off even on capable hardware." },
  { id: "attempt-on", label: "Attempt On", hint: "Force Power Mode on. On insufficient VRAM this fails honestly — it does not fake the capability." },
];

export function HardwareSection() {
  const [status, setStatus] = useState<PowerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [authed, setAuthed] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/power", { cache: "no-store" });
      if (r.ok) setStatus((await r.json()) as PowerStatus);
    } catch {
      /* offline */
    }
    try {
      const r = await fetch("/api/gpu", { cache: "no-store" });
      // GPU read is ungated; nothing to do with the body here beyond proving reach.
      if (!r.ok) { /* leave status as-is */ }
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setMode = useCallback(async (mode: OverrideMode) => {
    setBusy(true);
    try {
      const r = await fetch("/api/power", {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer() },
        body: JSON.stringify({ mode }),
      });
      if (r.status === 401) { setAuthed(false); return; }
      setAuthed(true);
      if (r.ok) setStatus((await r.json()) as PowerStatus);
    } finally {
      setBusy(false);
    }
  }, []);

  const tierLabel = status ? (status.tier === "ample" ? "POWER (ample)" : status.tier === "mid" ? "MID" : "STANDARD (lean)") : "…";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <div className="flex items-center gap-2 text-[15px] font-medium text-neutral-200">
          <Cpu size={16} strokeWidth={1.5} className="text-neutral-500" />
          Hardware & Power Mode
        </div>
        <p className="text-[12px] text-neutral-500 mt-1">
          ARGOS re-detects the GPU every boot and gates POWER-tier features behind it. Detection is the truth; the override is operator intent.
        </p>
      </div>

      {/* Detected tier */}
      <div className="rounded-lg border border-neutral-800/70 p-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Detected</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span data-testid="detected-tier" className={`text-[18px] font-semibold ${status?.tier === "ample" ? "text-emerald-300" : "text-sky-300"}`}>{tierLabel}</span>
          <span className="text-[12px] text-neutral-500">{status ? `${status.vramGb}GB VRAM` : ""}</span>
        </div>
      </div>

      {/* Override switch */}
      <div className="rounded-lg border border-neutral-800/70 p-4 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Power Mode override</div>
        {!authed && (
          <div className="text-[12px] text-amber-400 border border-dashed border-amber-900/50 rounded px-3 py-2">
            Operator session required to change the override — unlock with your PIN.
          </div>
        )}
        <div className="flex gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              data-mode={m.id}
              disabled={busy}
              onClick={() => void setMode(m.id)}
              className={
                "flex-1 rounded-md border px-3 py-2 text-[12px] transition-colors disabled:opacity-50 " +
                (status?.override === m.id
                  ? "border-sky-600/70 bg-sky-950/40 text-sky-200"
                  : "border-neutral-700 text-neutral-400 hover:bg-neutral-800/50")
              }
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>
        {status?.override && (
          <div className="text-[11px] text-neutral-500">{MODES.find((m) => m.id === status.override)?.hint}</div>
        )}
        {/* Honest attempt-on failure — explicit, never a fake success. */}
        {status?.attemptFailed && status.error && (
          <div data-testid="attempt-failed" className="text-[12px] text-red-300 border border-red-900/50 rounded px-3 py-2">
            {status.error}
          </div>
        )}
      </div>

      {/* Power-Mode capability + the gated feature list */}
      <div className="rounded-lg border border-neutral-800/70 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Power Mode</div>
          <span data-testid="power-available" className={`text-[12px] font-medium ${status?.available ? "text-emerald-300" : "text-neutral-500"}`}>
            {status?.available ? "AVAILABLE" : "UNAVAILABLE"}
          </span>
        </div>
        <div className="text-[12px] text-neutral-400">{status?.reason}</div>
        {/* Gated features — greyed + labeled when unavailable, VISIBLE not hidden. */}
        <ul className="mt-2 space-y-1">
          {(status?.enables ?? []).map((e, i) => (
            <li
              key={i}
              data-testid="gated-feature"
              className={`text-[12px] flex items-center gap-2 ${status?.available ? "text-neutral-300" : "text-neutral-600"}`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${status?.available ? "bg-emerald-400" : "bg-neutral-700"}`} />
              <span className={status?.available ? "" : "line-through decoration-neutral-700"}>{e}</span>
              {!status?.available && <span className="text-[10px] uppercase tracking-wider text-neutral-600">· Requires ≥24GB VRAM</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
