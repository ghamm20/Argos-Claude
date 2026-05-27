"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Download, History, Trash2 } from "lucide-react";
import { Eye } from "./Eye";
import { CitationPill } from "./CitationPill";
import { SessionList } from "./SessionList";
import { MicButton } from "./voice/MicButton";
import { PlayButton } from "./voice/PlayButton";
import { CodeProposalGate, extractCodeBlocks } from "./chat/CodeProposalGate";
import { Paperclip, ChevronDown, ChevronRight } from "lucide-react";
import {
  useArgos,
  type ChatMessage,
  type CitedHit,
} from "@/lib/store";
import { PERSONA_BY_ID } from "@/lib/personas";
import { chatToMarkdown, exportFilename } from "@/lib/chat-export";

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderWithCitations(
  content: string,
  hits: CitedHit[] | undefined,
  accent: string,
  onPillClick: (hit: CitedHit) => void
): React.ReactNode {
  if (!hits || hits.length === 0) return content;
  const re = /\[(\d+)\]/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let pillKey = 0;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) out.push(content.slice(last, m.index));
    const n = parseInt(m[1], 10);
    const hit = hits.find((h) => h.index === n);
    if (hit) {
      out.push(
        <CitationPill
          key={`pill-${pillKey++}`}
          n={n}
          accent={accent}
          onClick={() => onPillClick(hit)}
        />
      );
    } else {
      if (typeof console !== "undefined") {
        console.warn(
          `[citation] out-of-range marker [${n}] (only ${hits.length} hit(s) available) — rendering as plain text`
        );
      }
      out.push(m[0]);
    }
    last = re.lastIndex;
  }
  if (last < content.length) out.push(content.slice(last));
  return out;
}

/**
 * Phase 3-B (2026-05-25) — collapsible "📎 Sources ▾" block.
 *
 * Renders below an assistant message when retrieval returned hits. Closed
 * by default; one click expands. Shows confidence pill + filename + chunk
 * index per hit. No full-text preview (the existing CitationPill +
 * CitationDrawer combo already handles deep inspection on click).
 *
 * Hide rules:
 *   - No hits → don't render (zero "no sources found" message; doctrine)
 *   - Streaming → don't render (only show on finalized turns)
 *   - Errored → don't render
 */
function SourcesBlock({
  hits,
  accent,
  onHitClick,
}: {
  hits: CitedHit[];
  accent: string;
  onHitClick: (hit: CitedHit) => void;
}) {
  const [open, setOpen] = useState(false);
  if (hits.length === 0) return null;

  // Bucket by confidence so the operator scans top-down
  // (HIGH first, MED, LOW).
  const ranked = [...hits].sort((a, b) => {
    const cw = (c?: string) => (c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0);
    return cw(b.confidence) - cw(a.confidence) || b.score - a.score;
  });

  return (
    <div className="mt-2 pt-2 border-t border-neutral-800/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-neutral-500 hover:text-neutral-300 transition-colors"
        aria-expanded={open}
      >
        <Paperclip className="h-3 w-3" />
        Sources ({hits.length})
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 text-[11px]">
          {ranked.map((h) => (
            <li
              key={`src-${h.index}`}
              className="flex items-center gap-2 hover:bg-neutral-800/40 rounded px-1.5 py-0.5 cursor-pointer"
              onClick={() => onHitClick(h)}
              role="button"
            >
              <span
                className="inline-block text-[9px] uppercase tracking-wider px-1 rounded-sm border"
                style={{
                  borderColor:
                    h.confidence === "high"
                      ? "rgba(16,185,129,0.4)"
                      : h.confidence === "medium"
                        ? "rgba(234,179,8,0.4)"
                        : "rgba(115,115,115,0.4)",
                  color:
                    h.confidence === "high"
                      ? "#10b981"
                      : h.confidence === "medium"
                        ? "#eab308"
                        : "#a3a3a3",
                }}
              >
                {h.confidence?.toUpperCase() ?? "—"}
              </span>
              <span className="font-mono text-neutral-300 truncate flex-1" title={h.filename}>
                {h.filename}
              </span>
              <span className="text-neutral-600">chunk {h.chunkIndex}</span>
              <span className="text-neutral-600 font-mono">{h.score.toFixed(2)}</span>
              <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full" style={{ background: accent }} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onPillClick,
  sessionId,
  onRejectProposal,
}: {
  msg: ChatMessage;
  onPillClick: (hit: CitedHit) => void;
  sessionId?: string;
  /** Bobby v2: invoked when the operator clicks Reject under a code
   *  proposal. Receives the canonical REJECT_PROMPT_TEXT — parent
   *  feeds it back through the chat as a user-side turn. */
  onRejectProposal: (rejectionText: string) => void;
}) {
  const isUser = msg.role === "user";
  const persona = msg.personaId ? PERSONA_BY_ID[msg.personaId] : undefined;
  const accent = persona?.accentColor ?? "#737373";

  if (isUser) {
    return (
      <div className="flex justify-end my-3">
        <div className="max-w-[78%] rounded-lg bg-neutral-800/70 border border-neutral-700/60 px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-100 whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start my-3">
      <div
        className="max-w-[88%] rounded-lg border bg-neutral-950/60 px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-100 whitespace-pre-wrap"
        style={{
          borderColor: `${accent}40`,
          borderLeftWidth: 3,
          borderLeftColor: accent,
        }}
      >
        {persona && (
          <div
            className="text-[10px] uppercase tracking-[0.18em] mb-1.5 flex items-center"
            style={{ color: accent }}
          >
            <span>{persona.name}</span>
            {/* PlayButton was here previously — moved BELOW the message
                body for visibility. Operator confirmed the old icon-only
                version (h-5 w-5 / h-3 w-3 glyph / neutral-500) was
                effectively invisible against the dark bubble. */}
          </div>
        )}
        {msg.errored ? (
          <div className="text-red-400">{msg.content}</div>
        ) : (
          <>
            {/* Pre-first-token state: model is cold-loading or warming.
                Phase 2 (2026-05-25) directive: surface persona name in
                the loading label so the operator sees which model is
                being loaded during the 3-8s cold swap. */}
            {msg.isStreaming && msg.content.length === 0 ? (
              <span
                className="inline-flex items-center gap-1.5 text-[12px] text-neutral-500 italic"
                aria-live="polite"
              >
                <motion.span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: accent }}
                  animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1, 0.85] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                />
                Loading {persona?.name ?? "model"}…
              </span>
            ) : (
              <>
                <span>
                  {renderWithCitations(
                    msg.content,
                    msg.retrievalHits,
                    accent,
                    onPillClick
                  )}
                </span>
                {msg.isStreaming && (
                  <motion.span
                    className="inline-block ml-0.5 w-1.5 h-3 align-middle"
                    style={{ background: accent }}
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
                {/* Phase 3-B: collapsible Sources block. Only renders on
                    finalized assistant turns that actually used retrieval.
                    Inline citation pills above still render the [N] marks. */}
                {!msg.isStreaming && msg.retrievalHits && msg.retrievalHits.length > 0 && (
                  <SourcesBlock
                    hits={msg.retrievalHits}
                    accent={accent}
                    onHitClick={onPillClick}
                  />
                )}
                {/* Voice UX (2026-05-27): PlayButton lives BELOW the
                    message body now. Big teal "▶ Speak" button — see
                    components/voice/PlayButton.tsx header for the
                    why-it-was-invisible note. Self-hides if TTS isn't
                    available or message is empty. */}
                {!msg.errored && !msg.isStreaming && msg.content.length > 0 && (
                  <PlayButton
                    text={msg.content}
                    accent={accent}
                    sessionId={sessionId}
                    personaId={msg.personaId}
                  />
                )}
                {/* Bobby v2: in-chat approval gate. Only appears under
                    Bobby's FINALIZED messages that contain a fenced code
                    block. Approve copies to clipboard; Reject re-enters
                    the chat with a canonical rejection signal. Other
                    personas never get a gate — they're not approved to
                    propose executable code. */}
                {!msg.isStreaming &&
                  !msg.errored &&
                  msg.personaId === "bobby" &&
                  extractCodeBlocks(msg.content) !== null && (
                    <CodeProposalGate
                      content={msg.content}
                      accent={accent}
                      onReject={onRejectProposal}
                    />
                  )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface OllamaStreamLine {
  message?: { role?: string; content?: string };
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  total_duration?: number;
  error?: string;
  type?: string;
  hits?: CitedHit[] | null;
  enabled?: boolean;
}

export function ChatPane() {
  const messages = useArgos((s) => s.messages);
  const isStreaming = useArgos((s) => s.isStreaming);
  const currentModel = useArgos((s) => s.currentModel);
  const personaName = useArgos((s) => s.personaName());
  const accent = useArgos((s) => s.accentColor());
  const vaultDocs = useArgos((s) => s.vaultStatus.docs);
  const currentSessionId = useArgos((s) => s.currentSessionId);

  const appendMessage = useArgos((s) => s.appendMessage);
  const appendToLastMessage = useArgos((s) => s.appendToLastMessage);
  const patchLastMessage = useArgos((s) => s.patchLastMessage);
  const setStreaming = useArgos((s) => s.setStreaming);
  const setHudMetric = useArgos((s) => s.setHudMetric);
  const pushLatency = useArgos((s) => s.pushLatency);
  const setActiveCitation = useArgos((s) => s.setActiveCitation);
  const setVaultCounts = useArgos((s) => s.setVaultCounts);
  const clearChat = useArgos((s) => s.clearChat);

  const exportChat = useCallback(() => {
    const snap = useArgos.getState();
    if (snap.messages.length === 0) return;
    const exportedAt = Date.now();
    const md = chatToMarkdown(snap.messages, {
      model: snap.currentModel,
      exportedAt,
      personaName: snap.personaName(),
    });
    const fname = exportFilename(snap.personaName(), exportedAt);
    // Browser download — no host write from the app's perspective; the
    // browser's download dir is operator-controlled (per Rule #1 framing,
    // the operator owns whatever they choose to save).
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const onClearChat = useCallback(() => {
    if (isStreaming) return;
    if (messages.length === 0) return;
    // Lightweight confirmation — no modal dependency. Operator pressing
    // the trash by accident shouldn't nuke a session.
    if (typeof window !== "undefined" && !window.confirm("Clear the current chat?")) {
      return;
    }
    clearChat();
  }, [clearChat, isStreaming, messages.length]);

  const [draft, setDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Holds the in-flight stream's AbortController so the operator can
  // cancel mid-stream. Cleared in the `send` finally block.
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    const c = abortRef.current;
    if (!c) return;
    c.abort();
    abortRef.current = null;
  }, []);

  // Hydrate vault counts on mount so retrieval is enabled even if the user
  // never visits the Vault tab.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/vault/list", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as {
          documents: unknown[];
          totalChunks: number;
        };
        if (!cancelled)
          setVaultCounts(j.documents.length, j.totalChunks);
      } catch {
        /* offline, ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setVaultCounts]);

  // Phase 2 (2026-05-25) persona persistence — two-layer:
  //   1. localStorage `argos_active_persona` (browser-side, instant)
  //   2. /api/settings → config/settings.json (USB-native, canonical
  //      across machines/browsers)
  //
  // Resolution priority on mount: localStorage first (zero round-trip),
  // then /api/settings (authoritative). If they disagree, settings.json
  // wins because it's the doctrine-correct persistence — but localStorage
  // gets the UI re-skinned faster while the fetch is in flight.
  //
  // Doctrine note: USB-native persistence (settings.json on the drive)
  // is canonical. localStorage is a per-browser hint that survives a
  // page reload but doesn't survive moving the USB to another machine.
  // Both layers write on persona-switch (see PersonaSection.tsx +
  // additive localStorage call wired in store.switchPersona effect).
  useEffect(() => {
    let cancelled = false;

    // Layer 1 — localStorage (synchronous, no await)
    try {
      const localSaved = window.localStorage?.getItem("argos_active_persona");
      if (
        localSaved &&
        (localSaved === "bartimaeus" ||
          localSaved === "juniper" ||
          localSaved === "sage" ||
          localSaved === "bobby") &&
        localSaved !== useArgos.getState().currentPersonaId
      ) {
        void useArgos.getState().switchPersona(localSaved);
      }
    } catch {
      /* localStorage might be blocked (private mode); fall through to settings.json */
    }

    // Layer 2 — /api/settings (USB-native, authoritative)
    void (async () => {
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { defaultPersona?: string };
        if (cancelled) return;
        const persistedId = j.defaultPersona;
        if (
          persistedId &&
          (persistedId === "bartimaeus" ||
            persistedId === "juniper" ||
            persistedId === "sage" ||
            persistedId === "bobby") &&
          persistedId !== useArgos.getState().currentPersonaId
        ) {
          void useArgos.getState().switchPersona(persistedId);
        }
      } catch {
        /* offline, ignore — defaults already applied */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Phase 2 (2026-05-25) — mirror persona changes to localStorage as
  // they happen. Subscribes to currentPersonaId; writes the new id on
  // every change. Synchronous; no UI feedback needed.
  useEffect(() => {
    const unsubscribe = useArgos.subscribe((state, prevState) => {
      if (state.currentPersonaId !== prevState.currentPersonaId) {
        try {
          window.localStorage?.setItem(
            "argos_active_persona",
            state.currentPersonaId
          );
        } catch {
          /* localStorage might be blocked; settings.json carries the canonical state */
        }
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages]);

  // overrideText lets callers (e.g. Bobby v2's Reject button) inject a
  // user-side turn without first stuffing it into the textarea. When
  // omitted, send() uses the current draft (original behavior).
  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    if (!text || isStreaming) return;

    const snapshot = useArgos.getState().messages;
    const personaIdAtSend = useArgos.getState().currentPersonaId;
    const modelAtSend = useArgos.getState().currentModel;
    const useRetrieval = useArgos.getState().vaultStatus.docs > 0;

    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: makeId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      personaId: personaIdAtSend,
      isStreaming: true,
    };
    appendMessage(userMsg);
    appendMessage(assistantMsg);
    // Only clear the textarea draft when the send was driven from the
    // textarea — programmatic sends (e.g. Reject) must not clobber a
    // draft the operator may have been mid-typing.
    if (overrideText === undefined) setDraft("");
    setStreaming(true);

    const wireHistory = [...snapshot, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let liveTokenCount = 0;

    // Fresh AbortController per send so the Stop button can cancel
    // just this request without touching anything else.
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: wireHistory,
          personaId: personaIdAtSend,
          model: modelAtSend,
          useRetrieval,
          truthMode: useArgos.getState().truthMode,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        let parsed: { error?: string; hint?: string } | null = null;
        try {
          parsed = JSON.parse(errText);
        } catch {
          /* not JSON */
        }
        const msg = parsed?.error || errText || `request failed: ${res.status}`;
        const hint = parsed?.hint ? `\n${parsed.hint}` : "";
        patchLastMessage({
          content: `[error ${res.status}] ${msg}${hint}`,
          errored: true,
          isStreaming: false,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            let data: OllamaStreamLine | null = null;
            try {
              data = JSON.parse(line);
            } catch {
              data = null;
            }
            if (data?.error) {
              patchLastMessage({
                content: `[ollama] ${data.error}`,
                errored: true,
                isStreaming: false,
              });
              break;
            }
            if (data?.type === "retrieval") {
              patchLastMessage({
                retrievalHits: data.hits ?? undefined,
                retrievalError: data.hits ? null : "no retrieval hits",
              });
              continue;
            }
            const chunk = data?.message?.content;
            if (chunk) {
              if (firstTokenAt === null) {
                firstTokenAt = performance.now();
                setHudMetric("timeToFirstTokenMs", firstTokenAt - startedAt);
              }
              liveTokenCount += 1;
              appendToLastMessage(chunk);
              const sinceFirst = (performance.now() - firstTokenAt) / 1000;
              if (sinceFirst > 0.05) {
                setHudMetric("tokensPerSec", liveTokenCount / sinceFirst);
              }
            }
            if (data?.done) {
              const totalMs = performance.now() - startedAt;
              pushLatency(totalMs);
              const evalCount = data.eval_count ?? liveTokenCount;
              const evalDurationNs = data.eval_duration ?? 0;
              const tps =
                evalDurationNs > 0
                  ? evalCount / (evalDurationNs / 1e9)
                  : firstTokenAt !== null && performance.now() > firstTokenAt
                    ? liveTokenCount /
                      ((performance.now() - firstTokenAt) / 1000)
                    : 0;
              setHudMetric("totalTokens", evalCount);
              setHudMetric("tokensPerSec", tps);
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch (e) {
      // Operator-initiated abort is NOT an error — it's a clean stop.
      // Mark the message as no-longer-streaming and append a small
      // hint so the transcript shows what happened.
      if (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message))) {
        patchLastMessage({
          content: useArgos.getState().messages.at(-1)?.content
            ? `${useArgos.getState().messages.at(-1)?.content ?? ""}\n\n_[stopped by operator]_`
            : "_[stopped by operator]_",
          isStreaming: false,
        });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        patchLastMessage({
          content: `[network error] ${msg}`,
          errored: true,
          isStreaming: false,
        });
      }
    } finally {
      abortRef.current = null;
      patchLastMessage({ isStreaming: false });
      setStreaming(false);
      // Auto-save the session after the assistant turn completes. Fire-
      // and-forget — a save failure must not block the chat surface.
      // The store tracks currentSessionId; first save creates a new one,
      // subsequent saves upsert.
      void (async () => {
        try {
          const snap = useArgos.getState();
          const payload = {
            id: snap.currentSessionId ?? undefined,
            personaId: snap.currentPersonaId,
            model: snap.currentModel,
            messages: snap.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              personaId: m.personaId,
              retrievalHits: m.retrievalHits,
              retrievalError: m.retrievalError,
              errored: m.errored,
            })),
          };
          const r = await fetch("/api/chat/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!r.ok) return;
          const j = (await r.json()) as { id?: string };
          if (j.id && !useArgos.getState().currentSessionId) {
            useArgos.getState().setCurrentSessionId(j.id);
          }
        } catch {
          /* save best-effort; no user-visible error for transient saves */
        }
      })();
    }
  }, [
    draft,
    isStreaming,
    appendMessage,
    appendToLastMessage,
    patchLastMessage,
    setStreaming,
    setHudMetric,
    pushLatency,
  ]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  // Bobby v2: when the operator clicks Reject under a code proposal,
  // we re-enter the chat with a canonical rejection prompt. Reads like
  // an operator-typed turn (because it is, from Bobby's perspective).
  // Guarded against double-fire by isStreaming — if Bobby is mid-reply
  // the reject signal is dropped (operator can resend after Stop).
  const onRejectProposal = useCallback(
    (rejectionText: string) => {
      if (isStreaming) return;
      void send(rejectionText);
    },
    [isStreaming, send]
  );

  // Window-level shortcuts: Cmd/Ctrl+K to clear, Cmd/Ctrl+E to export,
  // Esc to stop streaming. Only fire when the user isn't typing in
  // another input (else they'd lose draft text or confirm by accident).
  useEffect(() => {
    function isTypingInOtherInput(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "SELECT") return true;
      if (tag === "TEXTAREA" && target !== textareaRef.current) return true;
      if (target.isContentEditable) return true;
      return false;
    }
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // Esc to stop streaming — only fires while streaming, no modifier
      if (e.key === "Escape" && !mod && useArgos.getState().isStreaming) {
        e.preventDefault();
        stop();
        return;
      }
      if (!mod) return;
      if (isTypingInOtherInput(e.target)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        onClearChat();
      } else if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        exportChat();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stop, onClearChat, exportChat]);

  const empty = messages.length === 0;

  return (
    <section className="flex-1 flex flex-col min-w-0">
      <div
        className={
          "flex flex-col items-center justify-center transition-all " +
          (empty ? "pt-10 pb-6" : "pt-5 pb-3 scale-75 origin-top")
        }
      >
        <Eye />
        {empty && (
          <div className="mt-4 text-[11px] uppercase tracking-[0.22em] text-neutral-500">
            {personaName}
            <span
              className="ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle"
              style={{ background: accent }}
            />
          </div>
        )}
      </div>

      {/* Chat actions: History is always visible (the operator may have
          past sessions even with an empty current chat). Export + Clear
          only visible when there's content to act on. */}
      <div className="absolute right-12 mt-3 z-10 flex gap-1.5">
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          title="History — past sessions"
          className={
            "rounded p-1.5 transition-colors " +
            (showHistory
              ? "text-neutral-200 bg-neutral-800/60"
              : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60")
          }
          aria-label="Toggle session history"
          aria-expanded={showHistory}
        >
          <History className="h-3.5 w-3.5" />
        </button>
        {!empty && (
          <>
            <button
              type="button"
              onClick={exportChat}
              title="Export chat as markdown (Cmd/Ctrl+E)"
              className="rounded p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
              aria-label="Export chat as markdown"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClearChat}
              disabled={isStreaming}
              title="Clear chat (Cmd/Ctrl+K) — starts a fresh session"
              className="rounded p-1.5 text-neutral-500 hover:text-red-400 hover:bg-neutral-800/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-neutral-500"
              aria-label="Clear chat"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {showHistory && <SessionList onClose={() => setShowHistory(false)} />}
      <div
        ref={scrollerRef}
        className="flex-1 px-10 py-4 overflow-y-auto relative"
      >
        <div className="max-w-2xl mx-auto">
          {empty ? (
            <p className="text-center text-neutral-600 text-[13px]">
              Local · Ollama · Persona {personaName}.{" "}
              {vaultDocs > 0
                ? `Retrieval over ${vaultDocs} doc${vaultDocs === 1 ? "" : "s"}.`
                : "No vault yet — chat will run without retrieval."}{" "}
              Cmd/Ctrl+Enter to send.
            </p>
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                onPillClick={(hit) => setActiveCitation(hit)}
                sessionId={currentSessionId ?? undefined}
                onRejectProposal={onRejectProposal}
              />
            ))
          )}
        </div>
      </div>

      <div className="px-10 pb-6 pt-3 border-t border-neutral-800/60">
        <div className="max-w-2xl mx-auto">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              disabled={isStreaming}
              placeholder={
                isStreaming
                  ? "Streaming…"
                  : `Message ${personaName} (Cmd/Ctrl+Enter to send)`
              }
              className="w-full resize-none bg-neutral-900/60 border border-neutral-800 rounded-md pl-4 pr-60 py-3 text-[13px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700 disabled:opacity-60"
            />
            {/* Mic input — self-hides when STT unavailable. Appends
                transcribed text to the current draft so the operator
                can dictate then type a tweak before sending. */}
            <MicButton
              accent={accent}
              disabled={isStreaming}
              sessionId={currentSessionId ?? undefined}
              onTranscribed={(text) =>
                setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
              }
            />
            {isStreaming ? (
              <button
                onClick={stop}
                title="Stop streaming"
                className="absolute right-1.5 bottom-1.5 rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors"
                style={{
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: "#ef4444",
                  color: "#ef4444",
                  background: "rgba(0,0,0,0.4)",
                }}
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={draft.trim().length === 0}
                className="absolute right-1.5 bottom-1.5 rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed"
                style={{
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: !draft.trim() ? "#404040" : accent,
                  color: !draft.trim() ? "#737373" : accent,
                  background: "rgba(0,0,0,0.4)",
                }}
              >
                Send
              </button>
            )}
          </div>
          <div className="mt-2 text-[10px] uppercase tracking-[0.18em] text-neutral-600 text-center">
            Network-off · 127.0.0.1:11434 only · Model {currentModel}
          </div>
        </div>
      </div>
    </section>
  );
}
