// app/memory/page.tsx
//
// Memory Audit Interface (2026-06-02) — the operator personally audits every
// fact Bobby extracts, the same discipline used on Jenna: catch hallucinations
// and bad reasoning before they're injected into prompts.
//
// Tabs:
//   - Fact Audit:  filterable/sortable/searchable table of every fact, with
//     expandable detail (session context + raw extraction) and per-fact +
//     bulk APPROVE / REJECT / EDIT / FLAG actions, plus CSV export.
//   - Hallucinations: the append-only flagged-fact log + pattern analysis.
//   - Profile:    operator profile editor + the Phase-9 memory store.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ----- types -----
type FactStatus = "unreviewed" | "approved" | "rejected" | "edited" | "flagged";
interface OperatorFact {
  id: string;
  fact: string;
  category: string;
  confidence: number;
  timestamp: string;
  sessionId: string | null;
  persona: string;
  status: FactStatus;
  originalFact?: string;
  reviewedAt?: string;
}
interface AuditSummary {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  byPersona: Record<string, number>;
  sessions: string[];
}
interface Extraction {
  at: string;
  model: string;
  userMessage: string;
  assistantMessage: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parseOk: boolean;
  factCount: number;
}
interface Hallucination {
  at: string;
  factId: string;
  fact: string;
  category: string;
  persona: string;
  sessionId: string | null;
  reason: string;
  extractionModel: string;
  sessionContext: string | null;
}
interface HallStats {
  total: number;
  byCategory: Record<string, number>;
  bySession: Record<string, number>;
  byPersona: Record<string, number>;
  worstCategory: string | null;
  worstPersona: string | null;
  worstSession: string | null;
}

const STATUS_COLOR: Record<FactStatus, string> = {
  unreviewed: "#a3a3a3",
  approved: "#10b981",
  rejected: "#737373",
  edited: "#3b82f6",
  flagged: "#ef4444",
};
const CATEGORIES = ["person", "project", "preference", "concern", "event"];
const STATUSES: FactStatus[] = ["unreviewed", "approved", "rejected", "edited", "flagged"];
type SortKey = "timestamp" | "persona" | "category" | "fact" | "confidence" | "status";

function shortIso(s: string): string {
  return s ? s.replace("T", " ").slice(0, 16) : "";
}

export default function MemoryPage() {
  const [tab, setTab] = useState<"audit" | "hallucinations" | "profile">("audit");

  // ===== Fact audit state =====
  const [facts, setFacts] = useState<OperatorFact[]>([]);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [fCategory, setFCategory] = useState("all");
  const [fPersona, setFPersona] = useState("all");
  const [fStatus, setFStatus] = useState("all");
  const [fMin, setFMin] = useState("");
  const [fMax, setFMax] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ fact: OperatorFact; extraction: Extraction | null } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [flagId, setFlagId] = useState<string | null>(null);
  const [flagReason, setFlagReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const loadFacts = useCallback(async () => {
    try {
      const r = await fetch("/api/memory/facts", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { facts?: OperatorFact[]; summary?: AuditSummary };
        setFacts(j.facts ?? []);
        setSummary(j.summary ?? null);
      }
    } catch {
      /* offline */
    }
  }, []);

  // ===== Hallucinations state =====
  const [halls, setHalls] = useState<Hallucination[]>([]);
  const [hallStats, setHallStats] = useState<HallStats | null>(null);
  const loadHalls = useCallback(async () => {
    try {
      const r = await fetch("/api/memory/hallucinations", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { items?: Hallucination[]; stats?: HallStats };
        setHalls(j.items ?? []);
        setHallStats(j.stats ?? null);
      }
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void loadFacts();
    void loadHalls();
  }, [loadFacts, loadHalls]);

  // ===== filtering + sorting (client-side over the loaded set) =====
  const filtered = useMemo(() => {
    const min = fMin === "" ? null : Number(fMin);
    const max = fMax === "" ? null : Number(fMax);
    const q = search.trim().toLowerCase();
    let out = facts.filter((x) => {
      if (fCategory !== "all" && x.category !== fCategory) return false;
      if (fPersona !== "all" && x.persona !== fPersona) return false;
      if (fStatus !== "all" && x.status !== fStatus) return false;
      if (min !== null && x.confidence < min) return false;
      if (max !== null && x.confidence > max) return false;
      if (fFrom && x.timestamp.slice(0, 10) < fFrom) return false;
      if (fTo && x.timestamp.slice(0, 10) > fTo) return false;
      if (q && !x.fact.toLowerCase().includes(q)) return false;
      return true;
    });
    const mul = sortDir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const av = sortKey === "confidence" ? a.confidence : (a[sortKey] as string);
      const bv = sortKey === "confidence" ? b.confidence : (b[sortKey] as string);
      return av < bv ? -1 * mul : av > bv ? 1 * mul : 0;
    });
    return out;
  }, [facts, fCategory, fPersona, fStatus, fMin, fMax, fFrom, fTo, search, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 2500);
  };

  const setStatus = useCallback(
    async (id: string, status: FactStatus, opts: { editedText?: string; reason?: string } = {}) => {
      const r = await fetch(`/api/memory/facts/${encodeURIComponent(id)}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, ...opts }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      flash(j.ok ? `marked ${status}` : `failed: ${j.error ?? ""}`);
      setEditId(null);
      setFlagId(null);
      await loadFacts();
      if (status === "flagged") await loadHalls();
    },
    [loadFacts, loadHalls]
  );

  const bulk = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      const r = await fetch("/api/memory/facts/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { ok?: boolean; updated?: number };
      flash(j.ok ? `${label}: ${j.updated ?? 0} updated` : "bulk failed");
      setSelected(new Set());
      await loadFacts();
      await loadHalls();
    },
    [loadFacts, loadHalls]
  );

  const openDetail = useCallback(async (f: OperatorFact) => {
    if (expanded === f.id) {
      setExpanded(null);
      setCtx(null);
      return;
    }
    setExpanded(f.id);
    setCtx(null);
    try {
      const r = await fetch(`/api/memory/facts/${encodeURIComponent(f.id)}/context`, { cache: "no-store" });
      if (r.ok) setCtx((await r.json()) as { fact: OperatorFact; extraction: Extraction | null });
    } catch {
      /* offline */
    }
  }, [expanded]);

  const exportCsv = () => {
    const p = new URLSearchParams();
    if (fCategory !== "all") p.set("category", fCategory);
    if (fPersona !== "all") p.set("persona", fPersona);
    if (fStatus !== "all") p.set("status", fStatus);
    if (fMin) p.set("minConfidence", fMin);
    if (fMax) p.set("maxConfidence", fMax);
    if (fFrom) p.set("from", fFrom);
    if (fTo) p.set("to", fTo);
    if (search.trim()) p.set("search", search.trim());
    window.open(`/api/memory/facts/export?${p.toString()}`, "_blank");
  };

  const toggleSel = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const allVisibleSelected = filtered.length > 0 && filtered.every((f) => selected.has(f.id));

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      className="text-left px-2 py-1 cursor-pointer select-none hover:text-neutral-200"
      onClick={() => toggleSort(k)}
    >
      {label} {sortKey === k ? (sortDir === "asc" ? "↑" : "↓") : ""}
    </th>
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 px-8 py-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-4">
          <h1 className="text-[20px] font-medium tracking-tight">Memory Audit</h1>
          <p className="text-[12px] text-neutral-500 mt-1">
            Review every fact Bobby extracts before it influences a persona. Rejected and flagged
            facts are excluded from prompt injection. Flagged facts are logged for pattern analysis.
          </p>
          {summary && (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
              <span className="text-neutral-400">{summary.total} facts</span>
              {STATUSES.map((s) => (
                <span key={s} style={{ color: STATUS_COLOR[s] }}>
                  {summary.byStatus[s] ?? 0} {s}
                </span>
              ))}
            </div>
          )}
        </header>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 border-b border-neutral-800">
          {(["audit", "hallucinations", "profile"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-[12px] -mb-px border-b-2 ${
                tab === t ? "border-emerald-500 text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {t === "audit" ? "Fact Audit" : t === "hallucinations" ? `Hallucinations${hallStats ? ` (${hallStats.total})` : ""}` : "Profile & Memories"}
            </button>
          ))}
          {msg && <span className="ml-auto self-center text-[11px] text-emerald-300">{msg}</span>}
        </div>

        {tab === "audit" && (
          <>
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2 mb-2 text-[12px]">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search fact text…" className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-56" />
              <select value={fCategory} onChange={(e) => setFCategory(e.target.value)} className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1">
                <option value="all">all categories</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={fPersona} onChange={(e) => setFPersona(e.target.value)} className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1">
                <option value="all">all personas</option>
                {(summary ? Object.keys(summary.byPersona) : ["bartimaeus", "bobby", "sage", "juniper"]).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1">
                <option value="all">all statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="text-neutral-600">conf</span>
              <input value={fMin} onChange={(e) => setFMin(e.target.value)} placeholder="min" className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-14" />
              <input value={fMax} onChange={(e) => setFMax(e.target.value)} placeholder="max" className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-14" />
              <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1" />
              <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1" />
              <button type="button" onClick={exportCsv} className="ml-auto text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800">Export CSV</button>
            </div>

            {/* Bulk bar */}
            <div className="flex flex-wrap items-center gap-2 mb-2 text-[11px] text-neutral-400">
              <span>{selected.size} selected</span>
              <button type="button" disabled={!selected.size} onClick={() => void bulk({ action: "setStatus", ids: [...selected], status: "approved" }, "approve")} className="px-2 py-0.5 rounded border border-emerald-800/60 text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-40">Approve</button>
              <button type="button" disabled={!selected.size} onClick={() => void bulk({ action: "setStatus", ids: [...selected], status: "rejected" }, "reject")} className="px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800 disabled:opacity-40">Reject</button>
              <button type="button" disabled={!selected.size} onClick={() => void bulk({ action: "setStatus", ids: [...selected], status: "flagged", reason: "bulk flag" }, "flag")} className="px-2 py-0.5 rounded border border-red-800/60 text-red-300 hover:bg-red-900/30 disabled:opacity-40">Flag</button>
              <span className="mx-1 text-neutral-700">|</span>
              <select id="approveSession" className="bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5 max-w-[180px]" defaultValue="">
                <option value="">approve all from session…</option>
                {summary?.sessions.map((s) => <option key={s} value={s}>{s.slice(0, 18)}</option>)}
              </select>
              <button type="button" onClick={() => { const el = document.getElementById("approveSession") as HTMLSelectElement | null; if (el?.value) void bulk({ action: "approveSession", sessionId: el.value }, "approve session"); }} className="px-2 py-0.5 rounded border border-emerald-800/60 text-emerald-300 hover:bg-emerald-900/30">Go</button>
              <button type="button" onClick={() => { if (window.confirm("Reject all UNREVIEWED facts older than 7 days?")) void bulk({ action: "rejectOldUnreviewed", olderThanDays: 7 }, "reject old"); }} className="px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800">Reject unreviewed &gt; 7d</button>
              <span className="ml-auto">{filtered.length} shown / {facts.length} total</span>
            </div>

            {/* Table */}
            <div className="border border-neutral-800 rounded-lg overflow-hidden">
              <table className="w-full text-[12px]">
                <thead className="bg-neutral-900/60 text-neutral-500 text-[11px]">
                  <tr>
                    <th className="px-2 py-1 w-6">
                      <input type="checkbox" checked={allVisibleSelected} onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((f) => f.id)) : new Set())} />
                    </th>
                    <Th k="timestamp" label="time" />
                    <Th k="persona" label="persona" />
                    <Th k="category" label="cat" />
                    <Th k="fact" label="fact" />
                    <Th k="confidence" label="conf" />
                    <Th k="status" label="status" />
                    <th className="px-2 py-1">actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={8} className="px-3 py-4 text-center text-neutral-600 italic">no facts match</td></tr>
                  ) : filtered.map((f) => (
                    <FactRow
                      key={f.id}
                      f={f}
                      selected={selected.has(f.id)}
                      onSelect={() => toggleSel(f.id)}
                      expanded={expanded === f.id}
                      onToggle={() => void openDetail(f)}
                      ctx={expanded === f.id ? ctx : null}
                      editing={editId === f.id}
                      editText={editText}
                      onEditStart={() => { setEditId(f.id); setEditText(f.fact); }}
                      onEditChange={setEditText}
                      onEditSave={() => void setStatus(f.id, "edited", { editedText: editText })}
                      flagging={flagId === f.id}
                      flagReason={flagReason}
                      onFlagStart={() => { setFlagId(f.id); setFlagReason(""); }}
                      onFlagChange={setFlagReason}
                      onFlagSave={() => void setStatus(f.id, "flagged", { reason: flagReason })}
                      onStatus={(s) => void setStatus(f.id, s)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "hallucinations" && (
          <div>
            {hallStats && hallStats.total > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 text-[12px]">
                <PatternCard title="Worst category" lead={hallStats.worstCategory} rec={hallStats.byCategory} />
                <PatternCard title="Worst persona" lead={hallStats.worstPersona} rec={hallStats.byPersona} />
                <PatternCard title="Worst session" lead={hallStats.worstSession ? hallStats.worstSession.slice(0, 16) : null} rec={hallStats.bySession} />
              </div>
            ) : (
              <div className="text-[12px] text-neutral-600 italic mb-4">No flagged hallucinations yet. Flag a suspect fact in the Fact Audit tab.</div>
            )}
            <div className="space-y-2">
              {halls.map((h, i) => (
                <div key={i} className="border border-red-900/40 rounded-lg p-3 bg-red-950/10 text-[12px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-neutral-100">{h.fact}</div>
                    <span className="text-[10px] text-neutral-600 font-mono shrink-0">{shortIso(h.at)}</span>
                  </div>
                  <div className="text-[11px] text-red-300 mt-1">why: {h.reason}</div>
                  <div className="text-[10px] text-neutral-500 mt-1 flex flex-wrap gap-3">
                    <span>cat {h.category}</span>
                    <span>persona {h.persona}</span>
                    <span>model {h.extractionModel}</span>
                    <span>session {h.sessionId ? h.sessionId.slice(0, 16) : "—"}</span>
                  </div>
                  {h.sessionContext && (
                    <pre className="mt-1 text-[10px] text-neutral-400 whitespace-pre-wrap bg-black/30 rounded p-2 max-h-28 overflow-y-auto">{h.sessionContext}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "profile" && <ProfileTab onClearedFacts={loadFacts} />}
      </div>
    </div>
  );
}

function FactRow(props: {
  f: OperatorFact;
  selected: boolean;
  onSelect: () => void;
  expanded: boolean;
  onToggle: () => void;
  ctx: { fact: OperatorFact; extraction: Extraction | null } | null;
  editing: boolean;
  editText: string;
  onEditStart: () => void;
  onEditChange: (s: string) => void;
  onEditSave: () => void;
  flagging: boolean;
  flagReason: string;
  onFlagStart: () => void;
  onFlagChange: (s: string) => void;
  onFlagSave: () => void;
  onStatus: (s: FactStatus) => void;
}) {
  const { f, ctx } = props;
  return (
    <>
      <tr className="border-t border-neutral-800/60 hover:bg-neutral-900/30">
        <td className="px-2 py-1 align-top"><input type="checkbox" checked={props.selected} onChange={props.onSelect} /></td>
        <td className="px-2 py-1 align-top font-mono text-[10px] text-neutral-500 whitespace-nowrap">{shortIso(f.timestamp)}</td>
        <td className="px-2 py-1 align-top text-neutral-400">{f.persona}</td>
        <td className="px-2 py-1 align-top"><span className="text-[10px] uppercase text-neutral-500">{f.category}</span></td>
        <td className="px-2 py-1 align-top text-neutral-200 cursor-pointer" onClick={props.onToggle}>
          {f.fact}
          {f.originalFact && f.originalFact !== f.fact && <span className="block text-[10px] text-neutral-600 line-through">{f.originalFact}</span>}
        </td>
        <td className="px-2 py-1 align-top font-mono text-neutral-500">{f.confidence.toFixed(2)}</td>
        <td className="px-2 py-1 align-top"><span className="text-[10px] uppercase" style={{ color: STATUS_COLOR[f.status] }}>{f.status}</span></td>
        <td className="px-2 py-1 align-top whitespace-nowrap">
          <button type="button" title="approve" onClick={() => props.onStatus("approved")} className="text-emerald-400 hover:text-emerald-200 mr-1">✓</button>
          <button type="button" title="reject" onClick={() => props.onStatus("rejected")} className="text-neutral-500 hover:text-neutral-300 mr-1">✕</button>
          <button type="button" title="edit" onClick={props.onEditStart} className="text-blue-400 hover:text-blue-200 mr-1">✎</button>
          <button type="button" title="flag as hallucination" onClick={props.onFlagStart} className="text-red-400 hover:text-red-200">⚑</button>
        </td>
      </tr>
      {props.editing && (
        <tr className="bg-neutral-900/40"><td colSpan={8} className="px-3 py-2">
          <div className="flex gap-2 items-center text-[12px]">
            <input value={props.editText} onChange={(e) => props.onEditChange(e.target.value)} className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1" />
            <button type="button" onClick={props.onEditSave} className="px-2 py-1 rounded bg-blue-900/40 border border-blue-700/60 text-blue-200 text-[11px]">Save edit</button>
          </div>
        </td></tr>
      )}
      {props.flagging && (
        <tr className="bg-red-950/20"><td colSpan={8} className="px-3 py-2">
          <div className="flex gap-2 items-center text-[12px]">
            <input value={props.flagReason} onChange={(e) => props.onFlagChange(e.target.value)} placeholder="why is this a hallucination?" className="flex-1 bg-neutral-900 border border-red-800/60 rounded px-2 py-1" />
            <button type="button" onClick={props.onFlagSave} className="px-2 py-1 rounded bg-red-900/40 border border-red-700/60 text-red-200 text-[11px]">Flag as hallucination</button>
          </div>
        </td></tr>
      )}
      {props.expanded && (
        <tr className="bg-black/30"><td colSpan={8} className="px-3 py-2 text-[11px]">
          {!ctx ? <span className="text-neutral-600 italic">loading transparency…</span> : (
            <div className="space-y-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">Conversation turn that produced this fact</div>
                {ctx.extraction ? (
                  <pre className="text-neutral-300 whitespace-pre-wrap bg-neutral-900/60 rounded p-2 max-h-40 overflow-y-auto">{`Operator: ${ctx.extraction.userMessage}\n\nAssistant: ${ctx.extraction.assistantMessage}`}</pre>
                ) : <span className="text-neutral-600 italic">no extraction record (fact predates transparency logging)</span>}
              </div>
              {ctx.extraction && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">What Bobby was told (prompt)</div>
                    <pre className="text-neutral-400 whitespace-pre-wrap bg-neutral-900/60 rounded p-2 max-h-40 overflow-y-auto">{ctx.extraction.userPrompt}</pre>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">What Bobby actually said (raw — parse {ctx.extraction.parseOk ? "ok" : "FAILED"})</div>
                    <pre className="text-neutral-400 whitespace-pre-wrap bg-neutral-900/60 rounded p-2 max-h-40 overflow-y-auto">{ctx.extraction.rawResponse || "(empty)"}</pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </td></tr>
      )}
    </>
  );
}

function PatternCard({ title, lead, rec }: { title: string; lead: string | null; rec: Record<string, number> }) {
  const entries = Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <div className="border border-neutral-800 rounded-lg p-3 bg-neutral-900/40">
      <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">{title}</div>
      <div className="text-[15px] text-red-300 mt-0.5">{lead ?? "—"}</div>
      <div className="mt-2 space-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex justify-between text-[11px] text-neutral-400">
            <span className="truncate">{k}</span>
            <span className="font-mono">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----- Profile tab: operator profile editor + clear-facts (compact) -----
interface OperatorProfile { name: string; role: string; context: string; preferences: Record<string, string>; last_updated: string; }
function ProfileTab({ onClearedFacts }: { onClearedFacts: () => void }) {
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/memory/profile", { cache: "no-store" });
      const j = (await r.json()) as { profile: OperatorProfile | null };
      setProfile(j.profile ?? { name: "", role: "", context: "", preferences: {}, last_updated: "" });
    } catch {
      /* offline */
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!profile) return;
    setBusy(true);
    try {
      const r = await fetch("/api/memory/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(profile) });
      const j = (await r.json()) as { ok?: boolean };
      setMsg(j.ok ? "saved." : "save failed");
      window.setTimeout(() => setMsg(null), 2000);
    } finally {
      setBusy(false);
    }
  }, [profile]);

  const clearFacts = useCallback(async () => {
    if (!window.confirm("Clear ALL extracted facts (operator_facts.jsonl)? MEMORY.md is preserved.")) return;
    await fetch("/api/memory/facts", { method: "DELETE" });
    onClearedFacts();
    setMsg("facts cleared.");
    window.setTimeout(() => setMsg(null), 2000);
  }, [onClearedFacts]);

  if (!profile) return <div className="text-[12px] text-neutral-600">loading…</div>;
  return (
    <section className="border border-neutral-800 rounded-lg p-4 bg-neutral-900/40 max-w-2xl">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[14px] font-medium text-neutral-100">Operator profile</h2>
        {msg && <span className="text-[11px] text-emerald-300">{msg}</span>}
      </div>
      <div className="space-y-3 text-[12px]">
        <label className="block"><span className="text-neutral-400">Name</span>
          <input className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label>
        <label className="block"><span className="text-neutral-400">Role</span>
          <input className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1" value={profile.role} onChange={(e) => setProfile({ ...profile, role: e.target.value })} /></label>
        <label className="block"><span className="text-neutral-400">Context</span>
          <textarea rows={3} className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1" value={profile.context} onChange={(e) => setProfile({ ...profile, context: e.target.value })} /></label>
        <div className="flex items-center gap-3 pt-1">
          <button type="button" onClick={() => void save()} disabled={busy} className="px-3 py-1.5 rounded bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 disabled:opacity-50">{busy ? "Saving…" : "Save profile"}</button>
          <button type="button" onClick={() => void clearFacts()} className="px-3 py-1.5 rounded border border-red-800/60 text-red-300 hover:bg-red-900/30 text-[11px]">Clear all facts</button>
        </div>
      </div>
    </section>
  );
}
