"use client";

// app/dashboard/page.tsx
//
// Stage 6 (2026-06-09) — the progression dashboard. ONE view: every system,
// version, live status. Live tiles show numbers traceable to a source (shown on
// hover); off-box systems render as visually-distinct STUBS (dashed, muted) and
// never fake liveness. All data from /api/dashboard. No new service/port.

import { useCallback, useEffect, useState } from "react";

interface Dash {
  generatedAt: string;
  tiles: Record<string, Record<string, unknown> & { live?: boolean; source?: string }>;
  stubs: Array<{ name: string; kind: string; note: string; repo: string }>;
}

function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}
function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

function Tile({ title, source, children, accent }: { title: string; source?: string; children: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800/70 bg-neutral-950/40 p-4" title={source ? `source: ${source}` : undefined}>
      <div className="flex items-center gap-2 mb-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent ?? "#10b981" }} />
        <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-neutral-300">{title}</span>
        <span className="ml-auto text-[9px] uppercase tracking-wider text-emerald-500/70">live</span>
      </div>
      {children}
    </div>
  );
}
function KV({ k, v, accent }: { k: string; v: React.ReactNode; accent?: string }) {
  return (
    <div className="flex items-center justify-between text-[11px] py-0.5">
      <span className="text-neutral-500">{k}</span>
      <span className="font-mono" style={{ color: accent ?? "#d4d4d4" }}>{v}</span>
    </div>
  );
}

export default function DashboardPage() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      if (!r.ok) { setErr(`stats ${r.status}`); return; }
      setD((await r.json()) as Dash);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  if (err) return <div className="p-6 text-[13px] text-red-400">Dashboard offline: {err}</div>;
  if (!d) return <div className="p-6 text-[13px] text-neutral-500">Loading…</div>;

  const t = d.tiles;
  const integ = t.integrity as Record<string, unknown>;
  const catch7 = integ.catchRate7d as number | null;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-[18px] font-semibold text-neutral-100">ARGOS — Progression</h1>
        <span className="text-[10px] text-neutral-600">updated {ago(d.generatedAt)}</span>
      </div>
      <p className="text-[11px] text-neutral-600 mb-5">Every live number is traceable — hover a tile for its source. Off-box systems are stubs (dashed), not faked liveness.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Tile title="ARGOS" source={String(t.argos.source)}>
          <KV k="version" v={String(t.argos.version)} />
          <KV k="BUILD_ID" v={t.argos.buildId ? String(t.argos.buildId).slice(0, 12) : "(dev)"} />
          <KV k="root" v={String(t.argos.argosRoot).slice(-22)} />
        </Tile>

        <Tile title="Integrity" source={String(t.integrity.source)} accent={catch7 != null && catch7 >= 0.9 ? "#10b981" : catch7 != null && catch7 >= 0.75 ? "#eab308" : "#ef4444"}>
          <KV k="catch rate 7d" v={pct(catch7)} accent={catch7 != null && catch7 >= 0.9 ? "#10b981" : "#eab308"} />
          <KV k="last run FP" v={pct(integ.lastFalsePositiveRate as number | null)} />
          <KV k="guard misses" v={(integ.misses as string[])?.length ?? 0} accent={(integ.misses as string[])?.length ? "#ef4444" : undefined} />
          <KV k="runs / last" v={`${integ.runs} · ${ago(integ.lastAt as string)}`} />
        </Tile>

        <Tile title="Tool Stack" source={String(t.toolStack.source)}>
          <KV k="tool model" v={String(t.toolStack.toolModel)} />
          <KV k="rebound models" v={t.toolStack.useReboundModels ? "on" : "off"} />
          <KV k="alias uses" v={Number(t.toolStack.aliasUses)} />
          <KV k="egress redactions" v={Number(t.toolStack.egressRedactions)} />
          <KV k="email injections" v={Number(t.toolStack.emailInjectionAttempts)} accent={Number(t.toolStack.emailInjectionAttempts) ? "#ef4444" : undefined} />
        </Tile>

        <Tile title="Inference" source={String(t.inference.source)}>
          <KV k="global" v={String(t.inference.global)} />
          <KV k="nous key" v={t.inference.nousConfigured ? "set" : "unset"} />
          {["bartimaeus", "juniper", "sage", "bobby"].map((p) => {
            const be = (t.inference.perPersona as Record<string, string>)?.[p] ?? "default";
            const pol = (t.inference.cloudDataPolicy as Record<string, string>)?.[p] ?? "redacted";
            return <KV key={p} k={p} v={`${be} · ${pol}`} accent={pol === "full" ? "#f59e0b" : undefined} />;
          })}
        </Tile>

        <Tile title="Agentic Tools" source={String(t.agenticTools.source)}>
          <KV k="file_ops" v={`${(t.agenticTools.file_ops as Record<string, unknown>).uses} uses`} />
          <KV k="tasks" v={`${(t.agenticTools.tasks as Record<string, unknown>).open} open · ${(t.agenticTools.tasks as Record<string, unknown>).completed} done`} />
          <KV k="email_read" v={String((t.agenticTools.email_read as Record<string, unknown>).status)} accent={String((t.agenticTools.email_read as Record<string, unknown>).status).startsWith("live") ? "#10b981" : "#737373"} />
        </Tile>

        <Tile title="Mirrors" source={String(t.mirrors.source)} accent={t.mirrors.parity === "DRIFT" ? "#ef4444" : t.mirrors.parity === "in-parity" ? "#10b981" : "#737373"}>
          <KV k="this BUILD_ID" v={t.mirrors.currentBuildId ? String(t.mirrors.currentBuildId).slice(0, 12) : "(dev)"} />
          <KV k="parity" v={String(t.mirrors.parity)} accent={t.mirrors.parity === "DRIFT" ? "#ef4444" : t.mirrors.parity === "in-parity" ? "#10b981" : "#a3a3a3"} />
          <KV k="configured roots" v={(t.mirrors.roots as unknown[])?.length ?? 0} />
        </Tile>

        <Tile title="GPU" source={String(t.gpu.source)} accent={t.gpu.tier === "ample" ? "#38bdf8" : t.gpu.tier === "mid" ? "#eab308" : "#10b981"}>
          <KV k="card" v={String(t.gpu.name)} />
          <KV k="VRAM" v={`${t.gpu.vramGb} GB`} />
          <KV k="tier" v={String(t.gpu.tier)} accent={t.gpu.tier === "ample" ? "#38bdf8" : undefined} />
          {t.gpu.forced ? <KV k="profile" v="FORCED (test)" accent="#f59e0b" /> : null}
        </Tile>

        <Tile title="Power Mode" source={String(t.powerMode.source)} accent={t.powerMode.available ? "#38bdf8" : "#737373"}>
          <KV k="status" v={t.powerMode.available ? "AVAILABLE" : "unavailable"} accent={t.powerMode.available ? "#38bdf8" : "#a3a3a3"} />
          <div className="text-[10px] text-neutral-500 mt-1 leading-relaxed">{String(t.powerMode.reason)}</div>
          {!t.powerMode.available && (
            <div className="text-[9px] text-neutral-600 mt-1.5">Activates automatically when an ample-tier GPU is detected — seat card, restart, pull ample models.</div>
          )}
        </Tile>
      </div>

      <div className="mt-6 mb-2 text-[11px] uppercase tracking-[0.18em] text-neutral-600">Off-box systems (stubs)</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {d.stubs.map((s) => (
          <div key={s.name} className="rounded-lg border border-dashed border-neutral-700/60 bg-neutral-950/20 p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
              <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-neutral-400">{s.name}</span>
              <span className="ml-auto text-[9px] uppercase tracking-wider text-neutral-600">stub</span>
            </div>
            <div className="text-[10px] text-neutral-500 leading-relaxed">{s.note}</div>
            <div className="text-[9px] font-mono text-neutral-700 mt-1">{s.repo}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
