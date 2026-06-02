// app/loops/page.tsx
//
// Self-Evolving Loop Suite (2026-06-02) — operator console for the 20
// improvement loops. Shows the loop registry (run any loop), the ground-truth
// benchmark, the command console (/debate, /simulate, /refine), pending
// high-risk patch approvals, and the append-only trace history.

"use client";

import { useCallback, useEffect, useState } from "react";

interface LoopSummary {
  id: string;
  loopNumber: number;
  name: string;
  description: string;
  trigger: "manual" | "scheduled" | "command";
  command: string | null;
  schedule: string | null;
  governed: boolean;
}
interface Stats {
  totalTraces: number;
  pendingApproval: number;
  halted: number;
  byOutcome: Record<string, number>;
}
interface Scheduler {
  running: boolean;
  autorun: boolean;
  windows: Array<{ id: string; label: string }>;
}
interface Trace {
  at: string;
  loopId: string;
  loopNumber: number;
  outcome: string;
  result: { summary: string };
  evaluation: { score: number; improved: boolean; gamingDetected: boolean; gamingReasons: string[] };
}
interface Pending {
  traceId: string;
  at: string;
  loopId: string;
  summary: string;
  proposals: Array<{ kind: string; description: string; target?: string }>;
}
interface PatchRec {
  at?: string;
  loopId?: string;
  reason?: string;
  testPassed?: boolean;
  files?: Array<{ target: string }>;
}
interface OpenQ {
  id: string;
  question: string;
  category: string;
}
interface BackupRec {
  id: string;
  loopId: string;
  reason: string;
  createdAt: string;
}

const OUTCOME_COLOR: Record<string, string> = {
  accepted: "#10b981",
  applied: "#3b82f6",
  rejected: "#a3a3a3",
  awaiting_approval: "#eab308",
  halted: "#ef4444",
  error: "#ef4444",
};

function shortIso(s: string): string {
  return s ? s.replace("T", " ").slice(0, 16) : "";
}

export default function LoopsPage() {
  const [loops, setLoops] = useState<LoopSummary[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scheduler, setScheduler] = useState<Scheduler | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [bench, setBench] = useState<{ score: number | null; at: string | null } | null>(null);
  const [patches, setPatches] = useState<{ applied: PatchRec[]; rolledBack: PatchRec[] }>({ applied: [], rolledBack: [] });
  const [questions, setQuestions] = useState<OpenQ[]>([]);
  const [backups, setBackups] = useState<BackupRec[]>([]);
  const [extra, setExtra] = useState<{ patchesToday?: { applied: number; rolledBack: number }; benchmark?: { trend: string }; pendingQuestions?: number } | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<{ title: string; body: string } | null>(null);

  const [debateTopic, setDebateTopic] = useState("");
  const [simAction, setSimAction] = useState("");
  const [refineText, setRefineText] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/loops/status", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as {
          loops: LoopSummary[];
          stats: Stats;
          scheduler: Scheduler;
          patchesToday?: { applied: number; rolledBack: number };
          benchmark?: { trend: string };
          pendingQuestions?: number;
        };
        setLoops(j.loops ?? []);
        setStats(j.stats ?? null);
        setScheduler(j.scheduler ?? null);
        setExtra({ patchesToday: j.patchesToday, benchmark: j.benchmark, pendingQuestions: j.pendingQuestions });
      }
    } catch {
      /* offline */
    }
  }, []);
  const loadPatches = useCallback(async () => {
    try {
      const r = await fetch("/api/loops/patches", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { applied: PatchRec[]; rolledBack: PatchRec[] };
        setPatches({ applied: j.applied ?? [], rolledBack: j.rolledBack ?? [] });
      }
    } catch {
      /* offline */
    }
  }, []);
  const loadQuestions = useCallback(async () => {
    try {
      const r = await fetch("/api/loops/questions", { cache: "no-store" });
      if (r.ok) setQuestions(((await r.json()) as { pending: OpenQ[] }).pending ?? []);
    } catch {
      /* offline */
    }
  }, []);
  const loadBackups = useCallback(async () => {
    try {
      const r = await fetch("/api/loops/rollback", { cache: "no-store" });
      if (r.ok) setBackups(((await r.json()) as { backups: BackupRec[] }).backups ?? []);
    } catch {
      /* offline */
    }
  }, []);
  const loadTraces = useCallback(async () => {
    try {
      const r = await fetch("/api/loops/traces?limit=25", { cache: "no-store" });
      if (r.ok) setTraces(((await r.json()) as { traces: Trace[] }).traces ?? []);
    } catch {
      /* offline */
    }
  }, []);
  const loadPending = useCallback(async () => {
    try {
      const r = await fetch("/api/loops/approve-patch", { cache: "no-store" });
      if (r.ok) setPending(((await r.json()) as { pending: Pending[] }).pending ?? []);
    } catch {
      /* offline */
    }
  }, []);
  const loadBench = useCallback(async () => {
    try {
      const r = await fetch("/api/loops/benchmark", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { latest: { result?: { benchmarkAfter?: number }; at?: string } | null };
        setBench({ score: j.latest?.result?.benchmarkAfter ?? null, at: j.latest?.at ?? null });
      }
    } catch {
      /* offline */
    }
  }, []);

  const refreshAll = useCallback(() => {
    void loadStatus();
    void loadTraces();
    void loadPending();
    void loadBench();
    void loadPatches();
    void loadQuestions();
    void loadBackups();
  }, [loadStatus, loadTraces, loadPending, loadBench, loadPatches, loadQuestions, loadBackups]);

  useEffect(() => {
    refreshAll();
    const t = setInterval(() => {
      void loadStatus();
      void loadPending();
      void loadQuestions();
    }, 6000);
    return () => clearInterval(t);
  }, [refreshAll, loadStatus, loadPending, loadQuestions]);

  const answerQ = useCallback(
    async (id: string) => {
      const answer = (answers[id] ?? "").trim();
      if (!answer) return;
      await fetch("/api/loops/questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, answer }),
      });
      setAnswers((a) => ({ ...a, [id]: "" }));
      void loadQuestions();
    },
    [answers, loadQuestions]
  );
  const restoreBackup = useCallback(
    async (id: string) => {
      if (!window.confirm(`Restore backup ${id}? This reverts the files it snapshotted.`)) return;
      const r = await fetch("/api/loops/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupId: id }),
      });
      const j = (await r.json()) as { ok?: boolean; restored?: number; reason?: string };
      setOut({ title: `restore ${id}`, body: j.ok ? `restored ${j.restored} file(s)` : `failed: ${j.reason}` });
      void loadBackups();
    },
    [loadBackups]
  );

  const runLoop = useCallback(
    async (loop: string, input: Record<string, unknown> = {}) => {
      setBusy(loop);
      setOut(null);
      try {
        const r = await fetch("/api/loops/evolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ loop, input }),
        });
        const j = (await r.json()) as {
          ok?: boolean;
          outcome?: string;
          result?: { summary?: string; data?: unknown };
          evaluation?: { gamingDetected?: boolean; gamingReasons?: string[] };
          error?: string;
        };
        const lines = [
          `outcome: ${j.outcome ?? "?"}`,
          j.result?.summary ? `summary: ${j.result.summary}` : "",
          j.evaluation?.gamingDetected ? `⛔ GAMING: ${(j.evaluation.gamingReasons ?? []).join("; ")}` : "",
          j.error ? `error: ${j.error}` : "",
          j.result?.data ? JSON.stringify(j.result.data, null, 2) : "",
        ].filter(Boolean);
        setOut({ title: loop, body: lines.join("\n") });
      } finally {
        setBusy(null);
        refreshAll();
      }
    },
    [refreshAll]
  );

  const runCommand = useCallback(
    async (route: string, body: Record<string, unknown>, label: string) => {
      setBusy(label);
      setOut(null);
      try {
        const r = await fetch(`/api/loops/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await r.json()) as { ok?: boolean; data?: unknown; error?: string };
        setOut({
          title: label,
          body: j.error ? `error: ${j.error}` : JSON.stringify(j.data ?? j, null, 2),
        });
      } finally {
        setBusy(null);
        refreshAll();
      }
    },
    [refreshAll]
  );

  const decide = useCallback(
    async (traceId: string, decision: "approve" | "reject") => {
      if (decision === "approve" && !window.confirm("Apply this patch? A restore point is created first.")) return;
      setBusy(traceId);
      try {
        const r = await fetch("/api/loops/approve-patch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ traceId, decision }),
        });
        const j = (await r.json()) as { ok?: boolean; note?: string; applied?: unknown[]; error?: string };
        setOut({ title: `approve-patch ${decision}`, body: j.error ?? j.note ?? JSON.stringify(j, null, 2) });
      } finally {
        setBusy(null);
        refreshAll();
      }
    },
    [refreshAll]
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 px-8 py-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6">
          <h1 className="text-[20px] font-medium tracking-tight">Loops</h1>
          <p className="text-[12px] text-neutral-500 mt-1">
            Self-evolving loop suite — 20 improvement loops behind an eval gate
            with real anti-gaming. Every run is recorded; the benchmark is ground
            truth. Nothing high-risk applies without your approval.{" "}
            {scheduler && (
              <span className="text-neutral-600">
                Scheduler {scheduler.running ? "running" : "idle"} · autorun{" "}
                {scheduler.autorun ? "on" : "off"}.
              </span>
            )}
          </p>
          {stats && (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-neutral-500">
              <span>{stats.totalTraces} traces</span>
              <span className="text-yellow-500">{stats.pendingApproval} awaiting approval</span>
              <span className="text-red-400">{stats.halted} halted (gaming)</span>
              {extra?.patchesToday && (
                <span className="text-emerald-400">
                  {extra.patchesToday.applied} patches applied · {extra.patchesToday.rolledBack} rolled back today
                </span>
              )}
              {extra?.benchmark && (
                <span>
                  benchmark{" "}
                  {extra.benchmark.trend === "up" ? "↑" : extra.benchmark.trend === "down" ? "↓" : extra.benchmark.trend === "flat" ? "→" : "—"}
                </span>
              )}
              {(extra?.pendingQuestions ?? 0) > 0 && (
                <span className="text-yellow-300">{extra!.pendingQuestions} question(s) awaiting answer</span>
              )}
            </div>
          )}
        </header>

        {/* Benchmark + command console */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <section className="border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
            <h2 className="text-[14px] font-medium text-neutral-100 mb-2">Benchmark (ground truth)</h2>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void runLoop("benchmark")}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded text-[12px] bg-blue-900/40 border border-blue-700/60 text-blue-200 hover:bg-blue-900/60 disabled:opacity-50"
              >
                {busy === "benchmark" ? "Running…" : "Run benchmark"}
              </button>
              <span className="text-[12px] text-neutral-400">
                {bench?.score !== null && bench?.score !== undefined
                  ? `Latest: ${(bench.score * 100).toFixed(0)}% (${shortIso(bench.at ?? "")})`
                  : "No benchmark yet"}
              </span>
            </div>
            <p className="text-[10px] text-neutral-600 mt-2">
              Deterministically graded known-answer tasks. No loop can claim
              improvement if this drops.
            </p>
          </section>

          <section className="border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
            <h2 className="text-[14px] font-medium text-neutral-100 mb-2">Command console</h2>
            <div className="space-y-2">
              <CommandRow
                placeholder="/debate topic…"
                value={debateTopic}
                onChange={setDebateTopic}
                disabled={busy !== null}
                onRun={() => void runCommand("debate", { topic: debateTopic }, "debate")}
              />
              <CommandRow
                placeholder="/simulate an action…"
                value={simAction}
                onChange={setSimAction}
                disabled={busy !== null}
                onRun={() => void runCommand("simulate", { action: simAction }, "simulate")}
              />
              <CommandRow
                placeholder="/refine some text…"
                value={refineText}
                onChange={setRefineText}
                disabled={busy !== null}
                onRun={() => void runCommand("refine", { text: refineText }, "refine")}
              />
            </div>
          </section>
        </div>

        {/* Output panel */}
        {out && (
          <section className="mb-6 border border-neutral-800 rounded-lg p-4 bg-black/40">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[13px] font-medium text-emerald-300">{out.title}</h2>
              <button type="button" onClick={() => setOut(null)} className="text-[11px] text-neutral-500 hover:text-neutral-300">
                close
              </button>
            </div>
            <pre className="text-[11px] text-neutral-300 whitespace-pre-wrap max-h-72 overflow-y-auto">{out.body}</pre>
          </section>
        )}

        {/* Pending approvals */}
        {pending.length > 0 && (
          <section className="mb-6 border border-yellow-800/60 rounded-lg p-4 bg-yellow-950/20">
            <h2 className="text-[14px] font-medium text-yellow-200 mb-3">
              Pending patch approvals ({pending.length})
            </h2>
            <div className="space-y-2">
              {pending.map((p) => (
                <div key={p.traceId} className="rounded border border-neutral-800 bg-black/30 px-3 py-2 text-[12px]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-neutral-100">
                        <span className="text-yellow-400">{p.loopId}</span> — {p.summary}
                      </div>
                      {p.proposals.map((pr, i) => (
                        <div key={i} className="text-[10px] text-neutral-500 mt-0.5">
                          [{pr.kind}] {pr.target ? `${pr.target}: ` : ""}{pr.description}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void decide(p.traceId, "approve")}
                        disabled={busy !== null}
                        className="text-[11px] px-2 py-1 rounded bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(p.traceId, "reject")}
                        disabled={busy !== null}
                        className="text-[11px] px-2 py-1 rounded text-red-300 hover:text-red-200"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Active-learning questions awaiting an answer */}
        {questions.length > 0 && (
          <section className="mb-6 border border-yellow-800/40 rounded-lg p-4 bg-yellow-950/10">
            <h2 className="text-[14px] font-medium text-yellow-200 mb-3">Questions awaiting your answer ({questions.length})</h2>
            <div className="space-y-2">
              {questions.map((q) => (
                <div key={q.id} className="text-[12px]">
                  <div className="text-neutral-200">
                    <span className="text-[10px] text-neutral-500 uppercase mr-1">{q.category}</span>
                    {q.question}
                  </div>
                  <div className="flex gap-2 mt-1">
                    <input
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      placeholder="your answer…"
                      className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
                    />
                    <button type="button" onClick={() => void answerQ(q.id)} className="text-[11px] px-3 py-1 rounded bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60">
                      answer
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Autonomous patches today + backups */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <section className="border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
            <h2 className="text-[14px] font-medium text-neutral-100 mb-2">
              Patches <span className="text-[11px] text-emerald-400">{patches.applied.length} applied</span>{" "}
              <span className="text-[11px] text-red-400">{patches.rolledBack.length} rolled back</span>
            </h2>
            <div className="space-y-1 max-h-44 overflow-y-auto text-[11px]">
              {patches.applied.length === 0 && patches.rolledBack.length === 0 && (
                <div className="text-neutral-600 italic">No autonomous patches yet.</div>
              )}
              {patches.applied.slice(0, 8).map((p, i) => (
                <div key={`a${i}`} className="text-neutral-400">
                  <span className="text-emerald-400">✓</span> {p.loopId} · {(p.files ?? []).map((f) => f.target).join(", ")} · {p.reason}
                </div>
              ))}
              {patches.rolledBack.slice(0, 8).map((p, i) => (
                <div key={`r${i}`} className="text-neutral-400">
                  <span className="text-red-400">↩</span> {p.loopId} · {(p.files ?? []).map((f) => f.target).join(", ")} · {p.reason}
                </div>
              ))}
            </div>
          </section>

          <section className="border border-neutral-800 rounded-lg p-4 bg-neutral-900/40">
            <h2 className="text-[14px] font-medium text-neutral-100 mb-2">Backups ({backups.length})</h2>
            <div className="space-y-1 max-h-44 overflow-y-auto text-[11px]">
              {backups.length === 0 ? (
                <div className="text-neutral-600 italic">No backups yet.</div>
              ) : (
                backups.map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-2">
                    <span className="text-neutral-400 truncate">
                      {shortIso(b.createdAt)} · {b.loopId} · {b.reason}
                    </span>
                    <button type="button" onClick={() => void restoreBackup(b.id)} className="text-[10px] text-amber-300 hover:text-amber-200 shrink-0">
                      restore
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* Loop registry */}
        <section className="mb-6">
          <h2 className="text-[14px] font-medium text-neutral-100 mb-3">The 20 loops</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {loops.map((l) => (
              <div key={l.id} className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-100">
                    <span className="text-neutral-600">#{l.loopNumber}</span> {l.name}
                    {l.governed && <span className="ml-1 text-[9px] text-amber-400 uppercase">gov</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => void runLoop(l.id)}
                    disabled={busy !== null}
                    className="text-[10px] px-2 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
                  >
                    {busy === l.id ? "…" : "run"}
                  </button>
                </div>
                <div className="text-[10px] text-neutral-500 mt-0.5">{l.description}</div>
                <div className="text-[9px] text-neutral-600 mt-0.5">
                  {l.trigger}
                  {l.schedule ? ` · ${l.schedule}` : ""}
                  {l.command ? ` · /${l.command}` : ""}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Recent traces */}
        <section>
          <h2 className="text-[14px] font-medium text-neutral-100 mb-3">Recent runs</h2>
          <div className="space-y-1">
            {traces.length === 0 ? (
              <div className="text-[11px] text-neutral-600 italic">No runs yet.</div>
            ) : (
              traces.map((t, i) => (
                <div key={i} className="flex items-center gap-3 text-[11px] border-b border-neutral-900 py-1">
                  <span className="w-28 text-neutral-600">{shortIso(t.at)}</span>
                  <span
                    className="w-32 uppercase tracking-wide"
                    style={{ color: OUTCOME_COLOR[t.outcome] ?? "#a3a3a3" }}
                  >
                    {t.outcome}
                  </span>
                  <span className="w-40 text-neutral-400">{t.loopId}</span>
                  <span className="text-neutral-500 flex-1 truncate">
                    {t.evaluation.gamingDetected ? `⛔ ${t.evaluation.gamingReasons[0] ?? "gaming"}` : t.result.summary}
                  </span>
                  <span className="text-neutral-600">{(t.evaluation.score * 100).toFixed(0)}%</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function CommandRow({
  placeholder,
  value,
  onChange,
  onRun,
  disabled,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[12px] text-neutral-100"
      />
      <button
        type="button"
        onClick={onRun}
        disabled={disabled || !value.trim()}
        className="text-[11px] px-3 py-1 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
      >
        run
      </button>
    </div>
  );
}
