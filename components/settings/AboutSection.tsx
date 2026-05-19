"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import type { HardwareProfile } from "@/lib/hardware";
import type { RuntimeInfo } from "@/lib/runtime-info";

export function AboutSection({ runtimeInfo }: { runtimeInfo: RuntimeInfo }) {
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const r = await fetch("/api/hardware", { cache: "no-store" });
        if (!r.ok) return;
        const hw = (await r.json()) as HardwareProfile;
        if (!cancel) setHardware(hw);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">About</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Build info, mount path, network posture.
      </p>

      <div className="rounded-md border border-neutral-800 bg-black/30 divide-y divide-neutral-800/70">
        <Row label="App" value={`${runtimeInfo.appName} v${runtimeInfo.version}`} />
        <Row
          label="Mode"
          value={runtimeInfo.isDev ? "Development (next dev)" : "Production"}
        />
        <Row label="ARGOS_ROOT" value={runtimeInfo.argosRoot} mono />
        <Row label="Ollama" value={runtimeInfo.ollamaUrl} mono />
        <Row
          label="GPU"
          value={
            hardware
              ? `${hardware.gpuName ?? "—"}${
                  hardware.vramGB > 0 ? ` · ${hardware.vramGB} GB VRAM` : ""
                }`
              : "—"
          }
        />
        <Row
          label="CPU"
          value={
            hardware
              ? `${hardware.cpuModel} · ${hardware.cpuCores} cores`
              : "—"
          }
        />
        <Row
          label="RAM"
          value={hardware ? `${hardware.totalRamGB} GB` : "—"}
        />
        <Row label="Platform" value={hardware?.platform ?? "—"} mono />
      </div>

      <div className="mt-6 flex items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
        <Shield size={16} strokeWidth={1.75} className="text-emerald-400 shrink-0" />
        <div>
          <div className="text-[12px] text-emerald-300 font-medium">
            Network posture: Local only
          </div>
          <div className="text-[11px] text-neutral-400 mt-0.5">
            Only outbound endpoint at runtime is 127.0.0.1:11434 (Ollama). No
            telemetry. No CDN. No external analytics. Verified by
            verify-argos.mjs and the project ESLint config.
          </div>
        </div>
      </div>

      <div className="mt-6 text-[10px] uppercase tracking-[0.18em] text-neutral-600">
        Doctrine: docs/00-DOCTRINE.md · Rules: docs/01-SEVEN-RULES.md ·
        Scope: docs/02-SCOPE-LOCK.md
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between px-4 py-2.5 gap-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 pt-0.5 whitespace-nowrap">
        {label}
      </div>
      <div
        className={
          "text-[12px] text-neutral-200 text-right break-all " +
          (mono ? "font-mono" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}
