// app/tasks/page.tsx
//
// Overnight Engine (2026-06-02) — operator-facing Tasks page. Drop a goal, walk
// away, wake up to a result + a morning brief. Shows the morning brief, a task
// creation form, and the queue/running/complete/failed columns.

"use client";

import { useCallback, useEffect, useState } from "react";

interface TaskFile {
  id: string;
  goal: string;
  steps: string[];
  priority: "low" | "normal" | "high";
  run_at: string | null;
  notify_on: "complete" | "error" | "both";
  dangerous_tools_allowed: boolean;
  created: string;
}
interface TaskResult {
  summary?: string;
  stepsOk?: number;
  stepsPlanned?: number;
  completedAt?: string;
}
interface Listing {
  queued: TaskFile[];
  running: TaskFile[];
  complete: Array<TaskFile & { result?: TaskResult }>;
  failed: Array<TaskFile & { error?: { error?: unknown } }>;
  runningId: string | null;
  completedToday: number;
  scheduler?: { running: boolean; briefTime: string; runningTask: string | null };
}
interface Brief {
  date: string;
  content: string;
}

function shortIso(s: string): string {
  return s ? s.replace("T", " ").slice(0, 16) : "";
}
const PRIORITY_COLOR: Record<string, string> = {
  high: "#ef4444",
  normal: "#10b981",
  low: "#737373",
};

export default function TasksPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [goal, setGoal] = useState("");
  const [priority, setPriority] = useState("normal");
  const [runAt, setRunAt] = useState("");
  const [dangerous, setDangerous] = useState(false);
  const [notifyOn, setNotifyOn] = useState("complete");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks/queue", { cache: "no-store" });
      if (r.ok) setListing((await r.json()) as Listing);
    } catch {
      /* offline */
    }
  }, []);
  const loadBrief = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks/brief", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { brief: Brief | null };
        setBrief(j.brief);
      }
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadBrief();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load, loadBrief]);

  const createTask = useCallback(async () => {
    if (!goal.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/tasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: goal.trim(),
          priority,
          run_at: runAt.trim() || null,
          dangerous_tools_allowed: dangerous,
          notify_on: notifyOn,
        }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (r.ok && j.ok) {
        setMsg("Task queued.");
        setGoal("");
        setRunAt("");
        setDangerous(false);
        await load();
        window.setTimeout(() => setMsg(null), 2500);
      } else {
        setMsg(`Create failed: ${j.error ?? r.status}`);
      }
    } finally {
      setBusy(false);
    }
  }, [goal, priority, runAt, dangerous, notifyOn, load]);

  const cancel = useCallback(
    async (id: string) => {
      if (!window.confirm("Cancel this queued task?")) return;
      const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { reason?: string };
        window.alert(`Cannot cancel: ${j.reason ?? r.status}`);
      }
      await load();
    },
    [load]
  );

  const runBriefNow = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/tasks/brief", { method: "POST" });
      await loadBrief();
    } finally {
      setBusy(false);
    }
  }, [loadBrief]);

  const Card = ({
    t,
    extra,
    onCancel,
  }: {
    t: TaskFile;
    extra?: React.ReactNode;
    onCancel?: () => void;
  }) => (
    <div className="rounded-md border border-neutral-800 bg-black/30 px-3 py-2 text-[12px]">
      <div className="flex items-start gap-2">
        <span
          className="mt-1 h-1.5 w-1.5 rounded-full shrink-0"
          style={{ background: PRIORITY_COLOR[t.priority] }}
          title={`priority ${t.priority}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-neutral-100">{t.goal}</div>
          <div className="text-[10px] text-neutral-500 mt-0.5 flex flex-wrap gap-2">
            <span>{shortIso(t.created)}</span>
            {t.run_at && <span>@ {t.run_at}</span>}
            <span>{t.notify_on}</span>
            {t.dangerous_tools_allowed && <span className="text-amber-400">dangerous OK</span>}
          </div>
          {extra}
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-[10px] text-red-400 hover:text-red-200"
          >
            cancel
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 px-8 py-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-[20px] font-medium tracking-tight">Tasks</h1>
          <p className="text-[12px] text-neutral-500 mt-1">
            Overnight engine — drop a goal, ARGOS works it with Bartimaeus + the
            tool suite, and a morning brief waits for you.{" "}
            {listing?.scheduler && (
              <span className="text-neutral-600">
                Scheduler {listing.scheduler.running ? "running" : "idle"} · brief{" "}
                {listing.scheduler.briefTime}.
              </span>
            )}
          </p>
        </header>

        {/* Morning brief */}
        <section className="mb-6 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-[14px] font-medium text-neutral-100">
              Morning brief{" "}
              {brief && <span className="text-neutral-500 text-[11px]">({brief.date})</span>}
            </h2>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void runBriefNow()}
                disabled={busy}
                className="text-[11px] text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
              >
                Run brief now
              </button>
              {brief && (
                <button
                  type="button"
                  onClick={() => setBriefOpen((v) => !v)}
                  className="text-[11px] text-emerald-300 hover:text-emerald-200"
                >
                  {briefOpen ? "Hide" : "View full brief"}
                </button>
              )}
            </div>
          </div>
          {!brief ? (
            <div className="text-[12px] text-neutral-600 italic">
              No brief yet — it generates daily at the configured time.
            </div>
          ) : briefOpen ? (
            <pre className="text-[12px] text-neutral-300 whitespace-pre-wrap bg-black/30 rounded p-3 max-h-96 overflow-y-auto">
              {brief.content}
            </pre>
          ) : (
            <div className="text-[12px] text-neutral-400 line-clamp-2">
              {brief.content.split("\n").slice(2, 5).join(" ").slice(0, 240)}…
            </div>
          )}
        </section>

        {/* Create task */}
        <section className="mb-6 border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
          <h2 className="text-[14px] font-medium text-neutral-100 mb-3">New task</h2>
          <textarea
            rows={2}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Goal — e.g. Research the top 3 access-control vendors and draft a comparison doc."
            className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-[12px] text-neutral-100 mb-2"
          />
          <div className="flex flex-wrap items-center gap-3 mb-2 text-[12px]">
            <label className="flex items-center gap-1">
              <span className="text-neutral-500">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
              >
                <option value="low">low</option>
                <option value="normal">normal</option>
                <option value="high">high</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-neutral-500">Run at</span>
              <input
                type="time"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
              />
              <span className="text-[10px] text-neutral-600">(blank = now)</span>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-neutral-500">Notify</span>
              <select
                value={notifyOn}
                onChange={(e) => setNotifyOn(e.target.value)}
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
              >
                <option value="complete">complete</option>
                <option value="error">error</option>
                <option value="both">both</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5" title="Allow Bart to run write/send/execute tools for this task">
              <input
                type="checkbox"
                checked={dangerous}
                onChange={(e) => setDangerous(e.target.checked)}
              />
              <span className={dangerous ? "text-amber-400" : "text-neutral-500"}>
                dangerous tools
              </span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void createTask()}
              disabled={busy || !goal.trim()}
              className="px-3 py-1.5 rounded text-[12px] bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
            >
              Queue task
            </button>
            {msg && <span className="text-[11px] text-neutral-400">{msg}</span>}
          </div>
        </section>

        {/* Columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Column title="Queued" color="#a3a3a3" count={listing?.queued.length ?? 0}>
            {(listing?.queued ?? []).map((t) => (
              <Card key={t.id} t={t} onCancel={() => void cancel(t.id)} />
            ))}
          </Column>
          <Column title="Running" color="#10b981" count={listing?.running.length ?? 0}>
            {(listing?.running ?? []).map((t) => (
              <Card
                key={t.id}
                t={t}
                extra={<div className="text-[10px] text-emerald-400 mt-1">working…</div>}
              />
            ))}
          </Column>
          <Column title="Complete" color="#3b82f6" count={listing?.complete.length ?? 0}>
            {(listing?.complete ?? []).map((t) => (
              <Card
                key={t.id}
                t={t}
                extra={
                  t.result?.summary ? (
                    <div className="text-[10px] text-blue-300 mt-1">{t.result.summary}</div>
                  ) : null
                }
              />
            ))}
          </Column>
          <Column title="Failed" color="#ef4444" count={listing?.failed.length ?? 0}>
            {(listing?.failed ?? []).map((t) => (
              <Card
                key={t.id}
                t={t}
                extra={
                  <div className="text-[10px] text-red-400 mt-1">
                    {typeof t.error?.error === "string"
                      ? t.error.error
                      : JSON.stringify(t.error?.error ?? "failed").slice(0, 160)}
                  </div>
                }
              />
            ))}
          </Column>
        </div>
      </div>
    </div>
  );
}

function Column({
  title,
  color,
  count,
  children,
}: {
  title: string;
  color: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-neutral-800 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-neutral-900/60 border-b border-neutral-800"
        style={{ borderLeft: `3px solid ${color}` }}
      >
        <span className="text-[11px] uppercase tracking-[0.15em]" style={{ color }}>
          {title}
        </span>
        <span className="text-[11px] text-neutral-500">{count}</span>
      </div>
      <div className="p-2 space-y-2 min-h-[60px]">
        {count === 0 ? (
          <div className="text-[11px] text-neutral-600 italic px-1 py-1">empty</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
