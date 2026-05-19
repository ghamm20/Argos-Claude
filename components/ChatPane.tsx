"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Eye } from "./Eye";
import { useArgos, type ChatMessage } from "@/lib/store";
import { PERSONA_BY_ID } from "@/lib/personas";

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
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
            className="text-[10px] uppercase tracking-[0.18em] mb-1.5"
            style={{ color: accent }}
          >
            {persona.name}
          </div>
        )}
        {msg.errored ? (
          <div className="text-red-400">{msg.content}</div>
        ) : (
          <>
            <span>{msg.content}</span>
            {msg.isStreaming && (
              <motion.span
                className="inline-block ml-0.5 w-1.5 h-3 align-middle"
                style={{ background: accent }}
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
              />
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
}

export function ChatPane() {
  const messages = useArgos((s) => s.messages);
  const isStreaming = useArgos((s) => s.isStreaming);
  const currentPersonaId = useArgos((s) => s.currentPersonaId);
  const currentModel = useArgos((s) => s.currentModel);
  const personaName = useArgos((s) => s.personaName());
  const accent = useArgos((s) => s.accentColor());

  const appendMessage = useArgos((s) => s.appendMessage);
  const appendToLastMessage = useArgos((s) => s.appendToLastMessage);
  const patchLastMessage = useArgos((s) => s.patchLastMessage);
  const setStreaming = useArgos((s) => s.setStreaming);
  const setHudMetric = useArgos((s) => s.setHudMetric);
  const pushLatency = useArgos((s) => s.pushLatency);

  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || isStreaming) return;

    const snapshot = useArgos.getState().messages;
    const personaIdAtSend = useArgos.getState().currentPersonaId;
    const modelAtSend = useArgos.getState().currentModel;

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
    setDraft("");
    setStreaming(true);

    const wireHistory = [...snapshot, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let liveTokenCount = 0;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: wireHistory,
          personaId: personaIdAtSend,
          model: modelAtSend,
        }),
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
      const msg = e instanceof Error ? e.message : String(e);
      patchLastMessage({
        content: `[network error] ${msg}`,
        errored: true,
        isStreaming: false,
      });
    } finally {
      patchLastMessage({ isStreaming: false });
      setStreaming(false);
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

      <div
        ref={scrollerRef}
        className="flex-1 px-10 py-4 overflow-y-auto"
      >
        <div className="max-w-2xl mx-auto">
          {empty ? (
            <p className="text-center text-neutral-600 text-[13px]">
              Local · Ollama · Persona {personaName}. Cmd/Ctrl+Enter to send.
            </p>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} msg={m} />)
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
              className="w-full resize-none bg-neutral-900/60 border border-neutral-800 rounded-md pl-4 pr-24 py-3 text-[13px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700 disabled:opacity-60"
            />
            <button
              onClick={() => void send()}
              disabled={isStreaming || draft.trim().length === 0}
              className="absolute right-1.5 bottom-1.5 rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed"
              style={{
                borderWidth: 1,
                borderStyle: "solid",
                borderColor:
                  isStreaming || !draft.trim() ? "#404040" : accent,
                color: isStreaming || !draft.trim() ? "#737373" : accent,
                background: "rgba(0,0,0,0.4)",
              }}
            >
              {isStreaming ? "…" : "Send"}
            </button>
          </div>
          <div className="mt-2 text-[10px] uppercase tracking-[0.18em] text-neutral-600 text-center">
            Network-off · 127.0.0.1:11434 only · Model {currentModel}
          </div>
        </div>
      </div>
    </section>
  );
}
