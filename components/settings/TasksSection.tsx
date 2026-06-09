"use client";

// components/settings/TasksSection.tsx
//
// Stage 2 (2026-06-09) — minimal READ-ONLY task ledger view. Mutations happen
// through the tasks tool (audited); this surface only reads /api/tasks. The
// full interactive view lands in the Stage 6 progression dashboard.

import { useCallback, useEffect, useState } from "react";
import { ListChecks, RefreshCw } from "lucide-react";

type TaskStatus = "open" | "completed" | "cancelled";
interface Task {
  id: string;
  title: string;
  note: string | null;
  due: string | null;
  source: string | null;
  proposed: boolean;
  status: TaskStatus;
  createdAt: string;
}
interface Counts {
  open: number;
  completed: number;
  cancelled: number;
  overdue: number;
}

const FILTERS: Array<TaskStatus | "all"> = ["open", "completed", "cancelled", "all"];

export function TasksSection() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [counts, setCounts] = useState<Counts>({ open: 0, completed: 0, cancelled: 0, overdue: 0 });
  const [filter, setFilter] = useState<TaskStatus | "all">("open");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/tasks?status=${filter}`, { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { tasks: Task[]; counts: Counts };
        setTasks(j.tasks ?? []);
        setCounts(j.counts ?? { open: 0, completed: 0, cancelled: 0, overdue: 0 });
      }
    } catch {
      /* offline */
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const now = new Date().toISOString();

  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-neutral-200">
        <ListChecks size={16} strokeWidth={1.5} className="text-neutral-500" />
        Task Ledger
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto text-neutral-500 hover:text-neutral-300"
          aria-label="Refresh"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <p className="mt-1 text-[12px] text-neutral-500 leading-relaxed">
        Read-only. Tasks are created and updated through the audited tasks tool
        (and, overnight, the night cycle as proposed tasks). {counts.open} open ·{" "}
        {counts.completed} done · {counts.cancelled} cancelled
        {counts.overdue > 0 && <span className="text-amber-400"> · {counts.overdue} overdue</span>}.
      </p>

      <div className="mt-4 inline-flex rounded-md border border-neutral-800 overflow-hidden">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              "px-3 py-1 text-[10px] uppercase tracking-wider transition-colors " +
              (filter === f
                ? "bg-neutral-700/70 text-neutral-100"
                : "text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-300")
            }
          >
            {f}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-1.5">
        {tasks.length === 0 && (
          <div className="text-[12px] text-neutral-600 py-3">No {filter} tasks.</div>
        )}
        {tasks.map((t) => {
          const overdue = t.status === "open" && t.due && t.due < now;
          return (
            <div
              key={t.id}
              className="rounded-md border border-neutral-800/70 bg-neutral-950/40 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded-sm border"
                  style={{
                    borderColor:
                      t.status === "open" ? "rgba(115,115,115,0.4)" : t.status === "completed" ? "rgba(16,185,129,0.4)" : "rgba(239,68,68,0.4)",
                    color: t.status === "open" ? "#a3a3a3" : t.status === "completed" ? "#10b981" : "#ef4444",
                  }}
                >
                  {t.status}
                </span>
                {t.proposed && (
                  <span className="text-[9px] uppercase tracking-wider text-amber-400/80">proposed</span>
                )}
                <span className="text-[13px] text-neutral-200">{t.title}</span>
                {t.due && (
                  <span className={"ml-auto text-[10px] " + (overdue ? "text-amber-400" : "text-neutral-500")}>
                    due {t.due}
                    {overdue && " (overdue)"}
                  </span>
                )}
              </div>
              {t.note && <div className="mt-1 text-[11px] text-neutral-500">{t.note}</div>}
              <div className="mt-1 text-[10px] text-neutral-600 font-mono">
                {t.id}
                {t.source && ` · ${t.source}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
