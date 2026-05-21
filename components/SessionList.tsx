"use client";

import { useEffect, useState, useCallback } from "react";
import { Trash2, X } from "lucide-react";
import { useArgos } from "@/lib/store";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";

interface SessionSummary {
  id: string;
  title: string;
  personaId: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSession = useArgos((s) => s.loadSession);
  const currentSessionId = useArgos((s) => s.currentSessionId);

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

  return (
    <div className="absolute right-12 top-2 z-20 w-80 max-h-[60vh] overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/95 backdrop-blur shadow-xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-400">
          History
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60"
          aria-label="Close history"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="p-2">
        {loading ? (
          <div className="px-2 py-3 text-[12px] text-neutral-500">Loading…</div>
        ) : error ? (
          <div className="px-2 py-3 text-[12px] text-red-400">{error}</div>
        ) : sessions.length === 0 ? (
          <div className="px-2 py-4 text-[12px] text-neutral-500 text-center">
            No saved sessions yet. Sessions auto-save after each assistant reply.
          </div>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => {
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
                      {isCurrent && (
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
