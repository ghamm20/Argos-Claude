"use client";

import { useEffect, useState } from "react";
import { useArgos } from "@/lib/store";
import { TruthModeToggle } from "./TruthModeToggle";
import { ToolsDock } from "@/components/panels/ToolsDock";
import { ShieldCheck } from "lucide-react";
import { AuthIndicator } from "./auth/AuthIndicator";
import { ResearchIndicator } from "./research/ResearchIndicator";
import { RoutingIndicator } from "./router/RoutingIndicator";
import { HeartbeatIndicator } from "./heartbeat/HeartbeatIndicator";
import { DispatcherIndicator } from "./dispatcher/DispatcherIndicator";
import type { HardwareProfile } from "@/lib/hardware";

interface HUDProps {
  argosRoot: string;
  version: string;
  startedAt: number;
}

function fmtMs(v: number): string {
  if (!v || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtTps(v: number): string {
  if (!v || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} tok/s`;
}

function fmtInt(v: number): string {
  if (!v || !Number.isFinite(v)) return "—";
  return v.toLocaleString();
}

function fmtUptime(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function Row({
  label,
  value,
  accent,
  title,
}: {
  label: string;
  value: React.ReactNode;
  accent?: string;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0">
      <span className="uppercase tracking-[0.16em] text-neutral-500">
        {label}
      </span>
      <span
        className="font-mono text-[11px] text-neutral-200 truncate max-w-[160px] text-right"
        style={accent ? { color: accent } : undefined}
        title={title ?? (typeof value === "string" ? value : undefined)}
      >
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="text-[9px] uppercase tracking-[0.22em] text-neutral-600 mb-1.5">
        {title}
      </div>
      <div className="rounded-md border border-neutral-800/70 bg-black/30 px-3 py-2">
        {children}
      </div>
    </div>
  );
}

export function HUD({ argosRoot, version, startedAt }: HUDProps) {
  const personaName = useArgos((s) => s.personaName());
  const eyeColor = useArgos((s) => s.eyeColor());
  const model = useArgos((s) => s.currentModel);
  const isStreaming = useArgos((s) => s.isStreaming);
  const m = useArgos((s) => s.hudMetrics);
  const vault = useArgos((s) => s.vaultStatus);
  const messages = useArgos((s) => s.messages);
  const truthMode = useArgos((s) => s.truthMode);
  const setVaultCounts = useArgos((s) => s.setVaultCounts);
  const currentSessionId = useArgos((s) => s.currentSessionId);
  // Phase 2-RB: visible model swap state (loading / ready / failed /
  // not_configured / idle). Drives the "Status" row in the Model section.
  const modelStatus = useArgos((s) => s.modelStatus);
  const modelStatusMessage = useArgos((s) => s.modelStatusMessage);
  // Vision Phase 1 — model used for the most recent image turn (else null).
  const lastVisionModel = useArgos((s) => s.lastVisionModel);
  // Memory Phase — cross-session recall for the most recent turn.
  const lastMemory = useArgos((s) => s.lastMemory);

  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // v1.1 Task 1: live audit chain event count.
  const [eventCount, setEventCount] = useState<number | null>(null);
  // Overnight Engine — task queue snapshot for the HUD TASKS row.
  const [tasks, setTasks] = useState<{
    queued: number;
    running: string | null;
    completedToday: number;
  } | null>(null);
  // v1.1 Task 6: runtime argosRoot from /api/system/info — overrides the
  // server-prop value baked at build time (which is wrong on deployed
  // payload). null means "still using the server-prop"; populated value
  // means the runtime fetch succeeded and we should prefer it.
  const [runtimeArgosRoot, setRuntimeArgosRoot] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const [hwRes, vaultRes, sysRes] = await Promise.all([
          fetch("/api/hardware", { cache: "no-store" }),
          fetch("/api/vault/list", { cache: "no-store" }),
          fetch("/api/system/info", { cache: "no-store" }),
        ]);
        if (cancel) return;
        if (hwRes.ok) setHw((await hwRes.json()) as HardwareProfile);
        if (vaultRes.ok) {
          const j = (await vaultRes.json()) as {
            documents: unknown[];
            totalChunks: number;
          };
          setVaultCounts(j.documents.length, j.totalChunks);
        }
        if (sysRes.ok) {
          const j = (await sysRes.json()) as {
            argosRoot?: string;
            isDev?: boolean;
          };
          if (j.argosRoot) {
            // Mirror the server-prop's dev tag convention.
            setRuntimeArgosRoot(j.isDev ? `${j.argosRoot} (dev)` : j.argosRoot);
          }
        }
      } catch {
        /* leave nulls; HUD shows — */
      }
    })();

    // v1.1 Task 1: poll audit chain event count. Cheap endpoint
    // (stat-based cache); 5s interval matches HUD's other refresh
    // signals without DoS'ing the chain reader.
    const fetchCount = async () => {
      try {
        const r = await fetch("/api/audit/count", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { count?: number };
        if (typeof j.count === "number") setEventCount(j.count);
      } catch {
        /* offline; keep prior count */
      }
    };
    void fetchCount();
    const countPoll = setInterval(() => void fetchCount(), 5000);

    // Overnight Engine — poll the task queue snapshot.
    const fetchTasks = async () => {
      try {
        const r = await fetch("/api/tasks/queue", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as {
          queued?: unknown[];
          running?: Array<{ goal?: string }>;
          completedToday?: number;
        };
        setTasks({
          queued: j.queued?.length ?? 0,
          running: j.running?.[0]?.goal ?? null,
          completedToday: j.completedToday ?? 0,
        });
      } catch {
        /* offline; keep prior */
      }
    };
    void fetchTasks();
    const tasksPoll = setInterval(() => void fetchTasks(), 5000);

    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancel = true;
      clearInterval(tick);
      clearInterval(countPoll);
      clearInterval(tasksPoll);
    };
  }, [setVaultCounts]);

  // Vault status row
  let vaultLabel: string;
  let vaultAccent: string | undefined;
  if (vault.ingesting) {
    vaultLabel = `Indexing: ${vault.ingesting}`;
    vaultAccent = eyeColor;
  } else if (vault.docs > 0) {
    vaultLabel = `${vault.docs} ${vault.docs === 1 ? "doc" : "docs"}, ${vault.chunks} ${vault.chunks === 1 ? "chunk" : "chunks"}`;
  } else {
    vaultLabel = "empty";
  }

  // Retrieval status row
  const lastAssistant = [...messages]
    .reverse()
    .find((msg) => msg.role === "assistant");
  const lastHitCount = lastAssistant?.retrievalHits?.length ?? 0;

  // Phase 3: confidence breakdown for the last assistant's retrieval set.
  // Counts hits by bucket so HUD can show "Last: 4 hits · 2H 1M 1L".
  const confidenceCounts = { high: 0, medium: 0, low: 0 };
  if (lastAssistant?.retrievalHits) {
    for (const h of lastAssistant.retrievalHits) {
      const c = h.confidence;
      if (c === "high" || c === "medium" || c === "low") confidenceCounts[c]++;
    }
  }
  const confBreakdown =
    confidenceCounts.high + confidenceCounts.medium + confidenceCounts.low > 0
      ? ` · ${confidenceCounts.high}H ${confidenceCounts.medium}M ${confidenceCounts.low}L`
      : "";

  let retrievalLabel: string;
  let retrievalAccent: string | undefined;
  if (isStreaming && vault.docs > 0 && lastHitCount === 0) {
    retrievalLabel = "Retrieving…";
    retrievalAccent = eyeColor;
  } else if (vault.docs === 0) {
    retrievalLabel = "empty (no vault)";
  } else if (lastHitCount > 0) {
    retrievalLabel = `Last: ${lastHitCount} hit${lastHitCount === 1 ? "" : "s"}${confBreakdown}`;
  } else {
    retrievalLabel = `ON (${vault.docs} ${vault.docs === 1 ? "doc" : "docs"}, ${vault.chunks} ${vault.chunks === 1 ? "chunk" : "chunks"})`;
  }

  // Citations used in the last assistant message
  let citationsUsed = 0;
  if (lastAssistant) {
    const matches = lastAssistant.content.match(/\[(\d+)\]/g);
    if (matches && lastAssistant.retrievalHits) {
      const maxIdx = lastAssistant.retrievalHits.length;
      citationsUsed = matches
        .map((mm) => parseInt(mm.slice(1, -1), 10))
        .filter((n) => n >= 1 && n <= maxIdx).length;
    }
  }

  // Mode + Reason from hardware
  const modeLabel = hw
    ? hw.mode === "gpu"
      ? `GPU · ${hw.gpuVendor.toUpperCase()}`
      : hw.mode === "metal"
        ? "Metal · Apple"
        : `CPU · ${hw.cpuCores} cores`
    : "—";
  const modeAccent = hw
    ? hw.mode === "gpu"
      ? "#10b981"
      : hw.mode === "metal"
        ? "#3b82f6"
        : "#a3a3a3"
    : undefined;
  const reasonShort = hw
    ? hw.reason.length > 24
      ? `${hw.reason.slice(0, 22)}…`
      : hw.reason
    : "—";

  const uptimeMs = now - startedAt;

  return (
    <aside className="w-[280px] shrink-0 border-l border-neutral-800/80 bg-black/30 px-4 py-5 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] uppercase tracking-[0.22em] text-neutral-400">
          HUD
        </div>
        <div className="flex items-center gap-2">
          {truthMode && (
            <span
              data-testid="hud-truth-badge"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border text-[9px] uppercase tracking-[0.18em]"
              style={{
                borderColor: eyeColor,
                color: eyeColor,
                background: `${eyeColor}14`,
              }}
            >
              <ShieldCheck size={9} strokeWidth={2} />
              Truth
            </span>
          )}
          <span
            data-testid="hud-stream-indicator"
            data-streaming={isStreaming ? "true" : "false"}
            className="h-1.5 w-1.5 rounded-full"
            style={{
              background: isStreaming ? eyeColor : "#3f3f46",
              boxShadow: isStreaming ? `0 0 6px ${eyeColor}` : "none",
            }}
            title={isStreaming ? "streaming" : "idle"}
          />
        </div>
      </div>

      <Section title="Model">
        <Row label="Model" value={model} />
        {/* Phase 2-RB: visible swap state. The store sets these during
            switchPersona → /api/model/warm → idle. Shown only when not
            "idle" so it doesn't permanently occupy a row. */}
        {modelStatus !== "idle" && (
          <Row
            label="Status"
            value={modelStatusMessage ?? modelStatus}
            accent={
              modelStatus === "loading"
                ? "#eab308"
                : modelStatus === "ready"
                  ? "#10b981"
                  : modelStatus === "failed"
                    ? "#ef4444"
                    : modelStatus === "not_configured"
                      ? "#f59e0b"
                      : undefined
            }
            title={modelStatusMessage ?? undefined}
          />
        )}
        <Row label="Mode" value={modeLabel} accent={modeAccent} />
        <Row
          label="Reason"
          value={reasonShort}
          title={hw?.reason}
        />
        {/* Vision Phase 1 — shows the multimodal model when the last turn
            carried an image. Self-hides on text-only turns. */}
        {lastVisionModel && (
          <Row
            label="Vision"
            value={lastVisionModel}
            accent="#10b981"
            title={`Last image turn routed to ${lastVisionModel}`}
          />
        )}
      </Section>

      <Section title="Inference">
        <Row label="Latency p50" value={fmtMs(m.p50LatencyMs)} />
        <Row label="Latency last" value={fmtMs(m.latencyMs)} />
        <Row label="TTFT" value={fmtMs(m.timeToFirstTokenMs)} />
        <Row label="Tokens/sec" value={fmtTps(m.tokensPerSec)} />
        <Row label="Tokens (eval)" value={fmtInt(m.totalTokens)} />
      </Section>

      <Section title="Context">
        <Row label="Persona" value={personaName} accent={eyeColor} />
        {/* Operator Auth (2026-05-28) — current auth state. Self-hides
            when settings.requirePin=false. Clickable: guest opens
            gate; operator offers lock-session. */}
        <AuthIndicator />
        {/* Phase 10 (2026-05-28) — research pipeline state for the
            most recent assistant turn (OFF/LIVE/CACHED/FAILED). */}
        <ResearchIndicator />
        {/* Phase 9 (router) — persona-routing suggestion for the most
            recent query. Suggestion only; never auto-switches. */}
        <RoutingIndicator />
        {/* Phase 10 (heartbeat) — ambient autonomous tick status. */}
        <HeartbeatIndicator />
        {/* Phase 11 (dispatcher) — last routed event + persona + count. */}
        <DispatcherIndicator />
        <Row label="Retrieval" value={retrievalLabel} accent={retrievalAccent} />
        {/* Memory Phase — cross-session recall for the last turn. Shows the
            number of facts brought forward; "—" when nothing recalled. */}
        <Row
          label="Memory"
          value={
            lastMemory && lastMemory.injected
              ? `${lastMemory.factsFound} recalled`
              : lastMemory
                ? "0 recalled"
                : "—"
          }
          accent={lastMemory?.injected ? eyeColor : undefined}
          title="Facts recalled from past sessions and injected into this turn"
        />
        <Row label="Vault" value={vaultLabel} accent={vaultAccent} />
        {/* Overnight Engine — task queue snapshot. */}
        <Row
          label="Tasks"
          value={
            tasks
              ? tasks.running
                ? `running · ${tasks.completedToday} done`
                : `${tasks.queued} queued · ${tasks.completedToday} done`
              : "—"
          }
          accent={tasks?.running ? eyeColor : undefined}
          title={
            tasks?.running
              ? `Running: ${tasks.running}`
              : tasks
                ? `${tasks.queued} queued, ${tasks.completedToday} completed today`
                : "task queue"
          }
        />
        {/* v1.1 Task 1: audit chain event count. Updates via /api/audit/count poll. */}
        <Row
          label="Events"
          value={eventCount === null ? "—" : fmtInt(eventCount)}
          accent={eventCount && eventCount > 0 ? eyeColor : undefined}
          title={
            eventCount === null
              ? "polling /api/audit/count…"
              : `${eventCount} entr${eventCount === 1 ? "y" : "ies"} on the hash-chained audit log`
          }
        />
        <Row
          label="Citations"
          value={citationsUsed > 0 ? `${citationsUsed} used` : "—"}
          accent={citationsUsed > 0 ? eyeColor : undefined}
        />
        <Row
          label="Session"
          value={
            currentSessionId
              ? `saved · ${currentSessionId.slice(0, 8)}`
              : messages.length === 0
                ? "—"
                : "unsaved (auto-saves on assistant reply)"
          }
          accent={currentSessionId ? eyeColor : undefined}
          title={
            currentSessionId
              ? `Full id: ${currentSessionId}`
              : "Sessions persist to ARGOS_ROOT/state/sessions after the first assistant reply"
          }
        />
      </Section>

      <Section title="Mode">
        <TruthModeToggle />
      </Section>

      <Section title="Host">
        {/* v1.1 Task 6: prefer the runtime value from /api/system/info
            when available — the server-prop `argosRoot` was baked at
            build time (page.tsx is statically rendered) and shows the
            dev-source path on the deployed payload. The runtime fetch
            corrects this once the HUD mounts. */}
        <Row
          label="USB path"
          value={runtimeArgosRoot ?? argosRoot}
          title={runtimeArgosRoot ?? argosRoot}
        />
        <Row label="Network" value="Local only" accent="#10b981" />
        <Row label="Build" value={`v${version}`} />
        <Row label="Uptime" value={fmtUptime(uptimeMs)} />
      </Section>

      {/* Tools integration (post-Phase-1). Self-contained component that polls
          /api/tools/status every 15s and renders tool cards by category. Sits
          inside HUD aside as the last block — non-destructive to existing
          telemetry layout. Move to a sibling panel later if right-rail space
          becomes contested. */}
      <div className="mt-4 -mx-4 -mb-5 border-t border-neutral-800/70">
        <ToolsDock />
      </div>
    </aside>
  );
}
