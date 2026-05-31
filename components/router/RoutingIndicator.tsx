// components/router/RoutingIndicator.tsx
//
// Phase 9 (router) — HUD "Routing" row. Reads routingSuggestion from
// Zustand (populated by ChatPane consuming the chat stream's leading
// `routing` event) and renders a SUBTLE, SUGGESTION-ONLY hint:
//
//   —                      neutral; no routing change suggested
//                          (router agreed with the active persona, or
//                           confidence was below the 0.7 gate)
//   → Juniper  87%         accent; the router suggests a different
//                          persona would fit this query better
//
// Suggestion only: this row NEVER switches the persona. The operator
// stays in control; a click on the persona rail is the only thing that
// actually changes who answers. Visual shape mirrors ResearchIndicator
// so HUD styling stays consistent.

"use client";

import { useArgos } from "@/lib/store";
import { PERSONA_BY_ID } from "@/lib/personas";

export function RoutingIndicator() {
  const rs = useArgos((s) => s.routingSuggestion);

  let value: React.ReactNode = "—";
  let color: string | undefined;
  let title = "No routing suggestion for the last query";

  // Only surface when the router cleared the 0.7 gate AND recommends a
  // persona other than the one currently answering.
  if (rs.surface && rs.recommended) {
    const p = PERSONA_BY_ID[rs.recommended];
    const name = p?.name ?? rs.recommended;
    const pct = Math.round(rs.confidence * 100);
    value = `→ ${name}  ${pct}%`;
    color = p?.accentColor ?? "#00ff9d";
    title =
      `Router suggests ${name} for the last query ` +
      `(confidence ${pct}%${rs.complexity === "high" ? ", multi-step" : ""}). ` +
      `Suggestion only — click the persona to switch.`;
  } else if (rs.recommended && rs.confidence > 0) {
    // Below the gate, or matches the active persona: show a muted note
    // so the row isn't dead, without nagging.
    title =
      `Router stayed on the current persona ` +
      `(top guess ${rs.recommended} @ ${Math.round(rs.confidence * 100)}%, below the 70% gate or already active).`;
  }

  return (
    <div
      className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0"
      title={title}
    >
      <span className="uppercase tracking-[0.16em] text-neutral-500">
        Routing
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
