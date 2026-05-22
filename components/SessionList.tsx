"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Trash2, X, Search, Download } from "lucide-react";
import { useArgos, type ChatMessage } from "@/lib/store";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";
import { bundleToMarkdown, bundleFilename } from "@/lib/chat-export";

interface SessionSummary {
  id: string;
  title: string;
  personaId: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionSearchHit extends SessionSummary {
  matchedIn: "title" | "message";
  matchedMessageIndex?: number;
  snippet: string;
}

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function SessionList({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSession = useArgos((s) => s.loadSession);
  const currentSessionId = useArgos((s) => s.currentSessionId);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/chat/sessions", { cache: "no-store" });
      if (!r.ok) {
        setError(`list failed ${r.status}`);
        return;
      }
      const j = (await r.json()) as { sessions: SessionSummary[] };
      setSessions(j.sessions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    try {
      const r = await fetch(
        `/api/chat/sessions?q=${encodeURIComponent(q.trim())}`,
        { cache: "no-store" }
      );
      if (!r.ok) {
        setError(`search failed ${r.status}`);
        return;
      }
      const j = (await r.json()) as { hits: SessionSearchHit[] };
      setHits(j.hits ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Debounce the search input — 200ms after last keystroke is plenty
  // for local-only fs scans.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void runSearch(query);
    }, 200);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, runSearch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onLoad = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`/api/chat/sessions/${id}`, { cache: "no-store" });
        if (!r.ok) {
          setError(`load failed ${r.status}`);
          return;
        }
        const session = (await r.json()) as {
          id: string;
          personaId: string;
          model: string;
          messages: Array<{
            id: string;
            role: "user" | "assistant" | "system";
            content: string;
            timestamp: number;
            personaId?: string;
            retrievalHits?: unknown[];
            retrievalError?: string | null;
            errored?: boolean;
          }>;
        };
        loadSession(
          session.id,
          session.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            personaId: m.personaId as PersonaId | undefined,
            retrievalHits: m.retrievalHits as never,
            retrievalError: m.retrievalError ?? null,
            errored: m.errored,
            isStreaming: false,
          })),
          session.personaId as PersonaId,
          session.model
        );
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadSession, onClose]
  );

  const [exporting, setExporting] = useState(false);
  const onExportAll = useCallback(async () => {
    if (exporting || sessions.length === 0) return;
    setExporting(true);
    try {
      // Fetch each session's full content. Sequential keeps the
      // dev-server request count predictable; ~50 sessions / 1ms each
      // is < 1s total in practice.
      const full: Array<Parameters<typeof bundleToMarkdown>[0][number]> = [];
      for (const s of sessions) {
        const r = await fetch(`/api/chat/sessions/${s.id}`, { cache: "no-store" });
        if (!r.ok) continue;
        const sess = (await r.json()) as {
          id: string;
          title: string;
          personaId: string;
          model: string;
          createdAt: number;
          updatedAt: number;
          messages: ChatMessage[];
        };
        const persona = PERSONA_BY_ID[sess.personaId as PersonaId];
        full.push({
          id: sess.id,
          title: sess.title,
          personaName: persona?.name ?? sess.personaId,
          model: sess.model,
          createdAt: sess.createdAt,
          updatedAt: sess.updatedAt,
          messages: sess.messages,
        });
      }
      if (full.length === 0) return;
      const exportedAt = Date.now();
      const md = bundleToMarkdown(full, { exportedAt });
      const fname = bundleFilename(full.length, exportedAt);
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setExporting(false);
    }
  }, [exporting, sessions]);

  const onDelete = useCallback(
    async (id: string, title: string) => {
      if (typeof window !== "undefined" && !window.confirm(`Delete session "${title}"?`)) {
        return;
      }
      try {
        const r = await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
        if (!r.ok) {
          setError(`delete failed ${r.status}`);
          return;
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh]
  );

  const isSearching = query.trim().length > 0;
  // Render either search hits or the full session list. Hits include
  // a snippet + matchedIn badge; full list is the existing layout.
  const renderRows: Array<SessionSummary & { snippet?: string; matchedIn?: string }> =
    isSearching ? (hits ?? []) : sessions;
  const emptyMessage = isSearching
    ? hits === null
      ? "Searching…"
      : `No matches for "${query}"`
    : "No saved sessions yet. Sessions auto-save after each assistant reply.";

  return (
    <div className="absolute right-12 top-2 z-20 w-80 max-h-[60vh] overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/95 backdrop-blur shadow-xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-400">
          History
        </div>
        <div className="flex items-center gap-0.5">
          {sessions.length > 0 && (
            <button
              onClick={() => void onExportAll()}
              disabled={exporting}
              title={`Export all ${sessions.length} session${sessions.length === 1 ? "" : "s"} as one markdown file`}
              className="rounded p-1 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Export all sessions"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60"
            aria-label="Close history"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="px-2 pt-2 pb-1">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-neutral-600 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="w-full bg-neutral-900/60 border border-neutral-800 rounded pl-7 pr-7 py-1.5 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Search sessions"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="p-2">
        {!isSearching && loading ? (
          <div className="px-2 py-3 text-[12px] text-neutral-500">Loading…</div>
        ) : error ? (
          <div className="px-2 py-3 text-[12px] text-red-400">{error}</div>
        ) : renderRows.length === 0 ? (
          <div className="px-2 py-4 text-[12px] text-neutral-500 text-center">
            {emptyMessage}
          </div>
        ) : (
          <ul className="space-y-1">
            {renderRows.map((s) => {
              const persona = PERSONA_BY_ID[s.personaId as PersonaId];
              const accent = persona?.eyeColor ?? "#737373";
              const isCurrent = s.id === currentSessionId;
              return (
                <li
                  key={s.id}
                  className={
                    "group relative rounded-md border px-2.5 py-2 transition-colors " +
                    (isCurrent
                      ? "border-neutral-600 bg-neutral-900/60"
                      : "border-neutral-800/60 hover:border-neutral-700 hover:bg-neutral-900/40")
                  }
                >
                  <button
                    onClick={() => void onLoad(s.id)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span
                        className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: accent }}
                      />
                      <span className="text-[12px] text-neutral-200 truncate flex-1">
                        {s.title}
                      </span>
                      {s.matchedIn && (
                        <span className="text-[9px] uppercase tracking-wider text-neutral-500 shrink-0">
                          {s.matchedIn}
                        </span>
                      )}
                      {isCurrent && !s.matchedIn && (
                        <span className="text-[9px] uppercase tracking-wider text-neutral-500 shrink-0">
                          current
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-neutral-500 flex items-center gap-2 pl-3.5">
                      <span>{persona?.name ?? s.personaId}</span>
                      <span>·</span>
                      <span>{s.messageCount} msg{s.messageCount === 1 ? "" : "s"}</span>
                      <span>·</span>
                      <span>{fmtRelative(s.updatedAt)}</span>
                    </div>
                    {s.snippet && (
                      <div className="mt-1 pl-3.5 text-[11px] text-neutral-400 italic line-clamp-2">
                        {s.snippet}
                      </div>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(s.id, s.title);
                    }}
                    title="Delete session"
                    className="absolute right-1.5 top-1.5 rounded p-1 text-neutral-500 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-neutral-800/60"
                    aria-label={`Delete session ${s.title}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
