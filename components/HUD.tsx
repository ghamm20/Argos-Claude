"use client";

import { useArgos } from "@/lib/store";

interface HUDProps {
  argosRoot: string;
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
  const iris = useArgos((s) => s.iris());

  return (
    <aside className="w-[280px] shrink-0 border-l border-neutral-800/80 bg-black/30 px-4 py-5 overflow-y-auto">
      <div className="text-[11px] uppercase tracking-[0.22em] text-neutral-400 mb-4">
        HUD
      </div>

      <Section title="Model">
        <Row label="Model" value="—" />
        <Row label="Mode" value="—" />
        <Row label="Reason" value="—" />
      </Section>

      <Section title="Inference">
        <Row label="Latency" value="—" />
        <Row label="Tokens/sec" value="—" />
      </Section>

      <Section title="Context">
        <Row label="Persona" value={personaName} accent={iris} />
        <Row label="Retrieval" value="Idle" />
      </Section>

      <Section title="Host">
        <Row label="USB path" value={argosRoot} />
        <Row label="Network" value="Local only" accent="#10b981" />
      </Section>

      <div className="mt-6 text-[9px] uppercase tracking-[0.2em] text-neutral-700 leading-relaxed">
        Hour 1 scaffold. Real metrics wire in Hour 2.
      </div>
    </aside>
  );
}
