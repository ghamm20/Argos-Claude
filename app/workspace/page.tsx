// app/workspace/page.tsx
//
// Phase 6 (2026-06-10) — WORKSPACE PILLARS. The operator console: a
// pillar-organized surface consistent with the five-interface frame
// (Bart, Jenna, Parascope, Cortex, Sentry). Reads as a console — status,
// queues, and decisions — not a chat app with tabs.
//
//   BART      — Proposals queue (morning review: approve / reject)
//   PARASCOPE — Workflows (chains; halted chains decided here)
//   JENNA     — Overnight (task queue + latest brief verdict lines)
//   CORTEX    — Memory & calibration (Brier over scored predictions)
//   SENTRY    — Integrity (audit chain, violations)
//
// PERSISTENCE: pillar order + collapsed state persist across relaunch via
// localStorage (key argos_pillars_v1); the panel DATA is server-durable by
// construction (proposals/workflows/audit are files under ARGOS_ROOT).
//
// SECURITY POSTURE: the Proposals/Workflows panels call requireToolSession-
// gated APIs with the operator session bearer. Without an unlocked session
// they render an honest "operator session required" notice — these panels
// release governed actions; a guest never sees or decides them.

"use client";

import { useCallback, useEffect, useState } from "react";
import { getSessionToken } from "@/lib/auth-client";

const PILLARS_KEY = "argos_pillars_v1";
const PILLAR_IDS = ["bart", "parascope", "jenna", "cortex", "sentry"] as const;
type PillarId = (typeof PILLAR_IDS)[number];

interface PillarPrefs {
  order: PillarId[];
  collapsed: Record<string, boolean>;
}
const DEFAULT_PREFS: PillarPrefs = { order: [...PILLAR_IDS], collapsed: {} };

function loadPrefs(): PillarPrefs {
  try {
    const raw = window.localStorage.getItem(PILLARS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as PillarPrefs;
    const order = (p.order ?? []).filter((id): id is PillarId => (PILLAR_IDS as readonly string[]).includes(id));
    for (const id of PILLAR_IDS) if (!order.includes(id)) order.push(id);
    return { order, collapsed: p.collapsed ?? {} };
  } catch {
    return DEFAULT_PREFS;
  }
}

// ---- API shapes (subset) ----
interface Proposal {
  id: string; type: string; title: string; rationale: string;
  confidence: number | null; status: string;
  predictedAsk: { topicClass: string; queryType: string } | null;
}
interface Calibration { n: number; brier: number; hits: number }
interface WorkflowState {
  id: string; title: string; status: string; cursor: number;
  steps: Array<{ toolId: string; description: string }>;
  halted: { toolId: string; resolvedParams: Record<string, unknown>; reason: string } | null;
}

const bearerHeaders = (): Record<string, string> => {
  const t = getSessionToken();
  return t ? { authorization: `Bearer ${t}` } : {};
};

const STATUS_COLOR: Record<string, string> = {
  pending: "text-amber-400", halted_approval: "text-amber-400",
  executed: "text-emerald-400", completed: "text-emerald-400",
  rejected: "text-neutral-500", aborted: "text-neutral-500",
  failed: "text-red-400", running: "text-sky-400",
};

function Pillar(props: {
  id: PillarId; title: string; sub: string; collapsed: boolean;
  onToggle: () => void; onMove: (dir: -1 | 1) => void; children: React.ReactNode;
}) {
  return (
    <section data-pillar={props.id} className="rounded-lg border border-neutral-800/80 bg-black/30 flex flex-col min-w-0">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-neutral-800/60">
        <button onClick={props.onToggle} className="text-left flex-1 min-w-0" data-testid={`toggle-${props.id}`}>
          <div className="text-[11px] uppercase tracking-[0.22em] text-neutral-400">{props.title}</div>
          <div className="text-[10px] tracking-wide text-neutral-600 truncate">{props.sub}</div>
        </button>
        <button onClick={() => props.onMove(-1)} className="px-1.5 text-neutral-600 hover:text-neutral-300" title="move up/left">▲</button>
        <button onClick={() => props.onMove(1)} className="px-1.5 text-neutral-600 hover:text-neutral-300" title="move down/right">▼</button>
        <span className="text-neutral-600 text-xs">{props.collapsed ? "+" : "—"}</span>
      </header>
      {!props.collapsed && <div className="p-4 text-[13px] text-neutral-300 space-y-2 overflow-auto max-h-[420px]">{props.children}</div>}
    </section>
  );
}

const Notice = ({ text }: { text: string }) => (
  <div className="text-[12px] text-neutral-500 border border-dashed border-neutral-800 rounded px-3 py-2">{text}</div>
);

export default function WorkspacePage() {
  const [prefs, setPrefs] = useState<PillarPrefs>(DEFAULT_PREFS);
  const [hydrated, setHydrated] = useState(false);
  const [authed, setAuthed] = useState(true);
  const [proposals, setProposals] = useState<{ pending: Proposal[]; decided: Proposal[] } | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowState[] | null>(null);
  const [tasks, setTasks] = useState<{ queued: number; complete: number; failed: number } | null>(null);
  const [verdicts, setVerdicts] = useState<string[]>([]);
  const [audit, setAudit] = useState<{ count: number } | null>(null);
  const [integrity, setIntegrity] = useState<{ lastCatchRate?: number | null; catchRate7d?: number | null; runs?: number } | null>(null);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setPrefs(loadPrefs());
    setHydrated(true);
  }, []);
  const savePrefs = useCallback((next: PillarPrefs) => {
    setPrefs(next);
    try { window.localStorage.setItem(PILLARS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }, []);
  const toggle = (id: PillarId) => savePrefs({ ...prefs, collapsed: { ...prefs.collapsed, [id]: !prefs.collapsed[id] } });
  const move = (id: PillarId, dir: -1 | 1) => {
    const order = [...prefs.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    savePrefs({ ...prefs, order });
  };

  const load = useCallback(async () => {
    // Gated surfaces (Bart + Parascope pillars).
    try {
      const r = await fetch("/api/proposals", { headers: bearerHeaders(), cache: "no-store" });
      if (r.status === 401) setAuthed(false);
      else if (r.ok) {
        setAuthed(true);
        const j = await r.json();
        setProposals({ pending: j.pending ?? [], decided: j.decided ?? [] });
        setCalibration(j.calibration ?? null);
      }
    } catch { /* offline */ }
    try {
      const r = await fetch("/api/workflows", { headers: bearerHeaders(), cache: "no-store" });
      if (r.ok) setWorkflows(((await r.json()).workflows ?? []) as WorkflowState[]);
    } catch { /* offline */ }
    // Ungated console data.
    try {
      const r = await fetch("/api/tasks/queue", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        setTasks({ queued: j.queued?.length ?? 0, complete: j.complete?.length ?? 0, failed: j.failed?.length ?? 0 });
      }
    } catch { /* offline */ }
    try {
      const r = await fetch("/api/tasks/brief", { cache: "no-store" });
      if (r.ok) {
        const content: string = (await r.json()).brief?.content ?? "";
        const block = content.split("## VERDICT BLOCK")[1] ?? "";
        setVerdicts(block.split("\n").filter((l) => l.startsWith("- ")).slice(0, 8));
      }
    } catch { /* offline */ }
    try {
      const r = await fetch("/api/audit/count", { cache: "no-store" });
      if (r.ok) setAudit(await r.json());
    } catch { /* offline */ }
    try {
      const r = await fetch("/api/integrity/metrics", { cache: "no-store" });
      if (r.ok) setIntegrity(await r.json());
    } catch { /* offline */ }
    try {
      const r = await fetch("/api/memory/facts", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        setMemoryCount(Array.isArray(j.facts) ? j.facts.length : j.count ?? null);
      }
    } catch { /* offline */ }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 7000);
    return () => clearInterval(t);
  }, [load]);

  const decideProposal = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    try {
      await fetch("/api/proposals/decide", {
        method: "POST",
        headers: { "content-type": "application/json", ...bearerHeaders() },
        body: JSON.stringify({ proposalId: id, decision }),
      });
      await load();
    } finally { setBusy(null); }
  };
  const decideWorkflow = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    try {
      await fetch("/api/workflows/decide", {
        method: "POST",
        headers: { "content-type": "application/json", ...bearerHeaders() },
        body: JSON.stringify({ workflowId: id, decision }),
      });
      await load();
    } finally { setBusy(null); }
  };

  const renderPillar = (id: PillarId) => {
    const collapsed = !!prefs.collapsed[id];
    const common = { collapsed, onToggle: () => toggle(id), onMove: (d: -1 | 1) => move(id, d) };
    switch (id) {
      case "bart":
        return (
          <Pillar key={id} id={id} title="BART — Proposals" sub="pre-staged actions awaiting your decision" {...common}>
            {!authed ? <Notice text="Operator session required — unlock with your PIN to review proposals." /> : !proposals ? <Notice text="loading…" /> : proposals.pending.length === 0 ? <Notice text="Queue empty — nothing proposed." /> : (
              proposals.pending.map((p) => (
                <div key={p.id} data-proposal={p.id} className="rounded border border-neutral-800/70 p-3 space-y-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-sky-400">[{p.type}]</span>
                    <span className="text-neutral-200 flex-1 min-w-0">{p.title}</span>
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {p.predictedAsk ? `predicted ${p.predictedAsk.topicClass}/${p.predictedAsk.queryType} · p=${(p.confidence ?? 0).toFixed(2)}` : "workspace context"}
                  </div>
                  <div className="text-[11px] text-neutral-500 line-clamp-2">{p.rationale}</div>
                  <div className="flex gap-2 pt-1">
                    <button disabled={busy === p.id} onClick={() => void decideProposal(p.id, "approve")} className="px-3 py-1 rounded border border-emerald-700/60 text-emerald-300 text-[12px] hover:bg-emerald-900/30 disabled:opacity-50">Approve</button>
                    <button disabled={busy === p.id} onClick={() => void decideProposal(p.id, "reject")} className="px-3 py-1 rounded border border-neutral-700 text-neutral-400 text-[12px] hover:bg-neutral-800/60 disabled:opacity-50">Reject</button>
                  </div>
                </div>
              ))
            )}
            {authed && proposals && proposals.decided.length > 0 && (
              <div className="text-[11px] text-neutral-600 pt-1">
                recent: {proposals.decided.slice(-4).map((p) => `${p.title.slice(0, 28)}→${p.status}`).join(" · ")}
              </div>
            )}
          </Pillar>
        );
      case "parascope":
        return (
          <Pillar key={id} id={id} title="PARASCOPE — Workflows" sub="governed chains; halted chains decided here" {...common}>
            {!authed ? <Notice text="Operator session required." /> : !workflows ? <Notice text="loading…" /> : workflows.length === 0 ? <Notice text="No workflows yet." /> : (
              workflows.slice(-8).reverse().map((w) => (
                <div key={w.id} data-workflow={w.id} className="rounded border border-neutral-800/70 p-3 space-y-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[10px] uppercase tracking-wider ${STATUS_COLOR[w.status] ?? "text-neutral-400"}`}>{w.status}</span>
                    <span className="text-neutral-200 flex-1 min-w-0">{w.title}</span>
                    <span className="text-[11px] text-neutral-600">step {Math.min(w.cursor + 1, w.steps.length)}/{w.steps.length}</span>
                  </div>
                  {w.status === "halted_approval" && w.halted && (
                    <>
                      <div className="text-[11px] text-amber-400/90">{w.halted.reason}</div>
                      <div className="text-[11px] text-neutral-500 font-mono truncate">{w.halted.toolId} {JSON.stringify(w.halted.resolvedParams)}</div>
                      <div className="flex gap-2 pt-1">
                        <button disabled={busy === w.id} onClick={() => void decideWorkflow(w.id, "approve")} className="px-3 py-1 rounded border border-emerald-700/60 text-emerald-300 text-[12px] hover:bg-emerald-900/30 disabled:opacity-50">Approve step</button>
                        <button disabled={busy === w.id} onClick={() => void decideWorkflow(w.id, "reject")} className="px-3 py-1 rounded border border-red-900/60 text-red-300 text-[12px] hover:bg-red-950/40 disabled:opacity-50">Reject (abort chain)</button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </Pillar>
        );
      case "jenna":
        return (
          <Pillar key={id} id={id} title="JENNA — Overnight" sub="task engine + latest brief verdicts" {...common}>
            {tasks ? (
              <div className="flex gap-4 text-[12px]">
                <span>queued <span className="text-amber-300">{tasks.queued}</span></span>
                <span>complete <span className="text-emerald-300">{tasks.complete}</span></span>
                <span>failed <span className="text-red-300">{tasks.failed}</span></span>
              </div>
            ) : <Notice text="loading…" />}
            {verdicts.length > 0 ? (
              <div className="space-y-1 font-mono text-[11px] text-neutral-400">
                {verdicts.map((v, i) => <div key={i} className="truncate">{v}</div>)}
              </div>
            ) : <Notice text="No morning brief yet." />}
          </Pillar>
        );
      case "cortex":
        return (
          <Pillar key={id} id={id} title="CORTEX — Memory & Calibration" sub="what ARGOS knows and how well it predicts" {...common}>
            <div className="text-[12px]">memory facts: <span className="text-neutral-200">{memoryCount ?? "—"}</span></div>
            {calibration ? (
              <div className="text-[12px]">
                predictions scored: <span className="text-neutral-200">{calibration.n}</span> · hits <span className="text-neutral-200">{calibration.hits}</span> · Brier <span className="text-neutral-200">{calibration.brier.toFixed(4)}</span>
                {calibration.n < 30 && <span className="text-neutral-600"> (trend surfaces at n≥30)</span>}
              </div>
            ) : <Notice text={authed ? "No predictions scored yet." : "Operator session required for calibration."} />}
          </Pillar>
        );
      case "sentry":
        return (
          <Pillar key={id} id={id} title="SENTRY — Integrity" sub="hash chains + guard verdicts" {...common}>
            <div className="text-[12px]">audit chain entries: <span className="text-neutral-200">{audit?.count ?? "—"}</span></div>
            <div className="text-[12px]">
              guard catch rate: <span className="text-neutral-200">{integrity?.lastCatchRate != null ? `${(integrity.lastCatchRate * 100).toFixed(1)}%` : "—"}</span>
              {integrity?.catchRate7d != null && <span className="text-neutral-600"> · 7d {(integrity.catchRate7d * 100).toFixed(1)}%</span>}
              {integrity?.runs != null && <span className="text-neutral-600"> · {integrity.runs} stress runs</span>}
            </div>
            <div className="text-[11px] text-neutral-600">guards: fabrication · misrepresentation · uncited-claim (Layer 2d)</div>
          </Pillar>
        );
    }
  };

  return (
    <main className="min-h-screen w-screen bg-neutral-950 text-neutral-200 overflow-auto">
      <header className="px-6 py-4 border-b border-neutral-800/80 flex items-baseline gap-4 sticky top-0 bg-neutral-950/95 backdrop-blur z-10">
        <a href="/" className="text-[18px] font-semibold tracking-[0.18em] text-neutral-100">ARGOS</a>
        <span className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">Workspace — Pillars</span>
        <span className="text-[10px] text-neutral-600 ml-auto">layout persists on this device</span>
      </header>
      {/* Responsive: 1 column on iPad portrait, 2 on landscape/desktop. */}
      <div data-testid="pillars-grid" className="p-4 md:p-6 grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-[1400px] mx-auto">
        {hydrated ? prefs.order.map(renderPillar) : null}
      </div>
    </main>
  );
}
