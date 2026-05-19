"use client";

import { useArgos } from "@/lib/store";
import { TruthModeToggle } from "./TruthModeToggle";
import { ShieldCheck } from "lucide-react";

interface HUDProps {
  argosRoot: string;
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

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0">
      <span className="uppercase tracking-[0.16em] text-neutral-500">
        {label}
      </span>
      <span
        className="font-mono text-[11px] text-neutral-200 truncate max-w-[160px] text-right"
        style={accent ? { color: accent } : undefined}
        title={typeof value === "string" ? value : undefined}
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

export function HUD({ argosRoot }: HUDProps) {
  const personaName = useArgos((s) => s.personaName());
  const eyeColor = useArgos((s) => s.eyeColor());
  const model = useArgos((s) => s.currentModel);
  const isStreaming = useArgos((s) => s.isStreaming);
  const m = useArgos((s) => s.hudMetrics);
  const vault = useArgos((s) => s.vaultStatus);
  const messages = useArgos((s) => s.messages);
  const truthMode = useArgos((s) => s.truthMode);

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

  let retrievalLabel: string;
  let retrievalAccent: string | undefined;
  if (isStreaming && vault.docs > 0 && lastHitCount === 0) {
    retrievalLabel = "Retrieving…";
    retrievalAccent = eyeColor;
  } else if (vault.docs === 0) {
    retrievalLabel = "empty (no vault)";
  } else if (lastHitCount > 0) {
    retrievalLabel = `Last: ${lastHitCount} hit${lastHitCount === 1 ? "" : "s"}`;
  } else {
    retrievalLabel = `ON (${vault.docs} ${vault.docs === 1 ? "doc" : "docs"}, ${vault.chunks} chunks)`;
  }

  // Citations used in the last assistant message
  let citationsUsed = 0;
  if (lastAssistant) {
    const matches = lastAssistant.content.match(/\[(\d+)\]/g);
    if (matches && lastAssistant.retrievalHits) {
      const maxIdx = lastAssistant.retrievalHits.length;
      citationsUsed = matches
        .map((m) => parseInt(m.slice(1, -1), 10))
        .filter((n) => n >= 1 && n <= maxIdx).length;
    }
  }

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
        <Row label="Mode" value="—" />
        <Row label="Reason" value="—" />
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
        <Row label="Retrieval" value={retrievalLabel} accent={retrievalAccent} />
        <Row label="Vault" value={vaultLabel} accent={vaultAccent} />
        <Row
          label="Citations"
          value={citationsUsed > 0 ? `${citationsUsed} used` : "—"}
          accent={citationsUsed > 0 ? eyeColor : undefined}
        />
      </Section>

      <Section title="Mode">
        <TruthModeToggle />
      </Section>

      <Section title="Host">
        <Row label="USB path" value={argosRoot} />
        <Row label="Network" value="Local only" accent="#10b981" />
      </Section>

      <div className="mt-6 text-[9px] uppercase tracking-[0.2em] text-neutral-700 leading-relaxed">
        Hardware mode + retrieval wire in Hour 3+.
      </div>
    </aside>
  );
}
