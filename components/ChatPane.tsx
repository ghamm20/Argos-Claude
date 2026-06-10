"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Download, History, Trash2, Radio } from "lucide-react";
import { Eye } from "./Eye";
import { CitationPill } from "./CitationPill";
import { SessionList } from "./SessionList";
import { SpeechMicButton } from "./voice/SpeechMicButton";
import { PlayButton } from "./voice/PlayButton";
import { SpeakerSelect } from "./voice/SpeakerSelect";
import { useConversationMode } from "@/lib/useConversationMode";
import { CodeProposalGate, extractCodeBlocks } from "./chat/CodeProposalGate";
// Operator Auth (2026-05-28) — inject the bearer token on every
// /api/chat send. When unset (guest), the header is omitted and the
// server falls back to guest mode if requirePin is enabled, or to
// operator mode otherwise.
import { getSessionToken } from "@/lib/auth-client";
import { Paperclip, ChevronDown, ChevronRight, Wrench, Brain } from "lucide-react";
// Chat-render cleanups (2026-06-02): strip <tool> control tags + split
// internal reasoning into a collapsible panel. Pure, client-safe helpers.
import { stripToolTags, splitReasoning } from "@/lib/chat-render";
// Vision Phase 1 (2026-06-02) — image drop, screenshot, preview strip.
import { ImageDropButton } from "./vision/ImageDropButton";
import { ScreenshotButton } from "./vision/ScreenshotButton";
import { ImagePreviewStrip } from "./vision/ImagePreviewStrip";
import { MAX_IMAGES, type AttachedImage } from "@/lib/vision-client";
import {
  useArgos,
  type ChatMessage,
  type CitedHit,
  type ToolResultCard,
} from "@/lib/store";
import {
  ToolApprovalDialog,
  type ToolApprovalReq,
  type ToolPlanStep,
} from "./tools/ToolApprovalDialog";
import { PERSONA_BY_ID, type PersonaId } from "@/lib/personas";
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

/**
 * Reasoning panel (2026-06-02). Collapsible, closed by default. Renders the
 * model's extracted internal monologue (<think> blocks or labeled prose like
 * "Self-Correction:" / "Internal Monologue:") below the clean answer. The main
 * bubble shows only the answer; reasoning is available on click.
 */
function ReasoningPanel({ text, accent }: { text: string; accent: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mt-2 pt-2 border-t border-neutral-800/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-neutral-500 hover:text-neutral-300 transition-colors"
        aria-expanded={open}
      >
        <Brain className="h-3 w-3" />
        Reasoning
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      {open && (
        <div
          className="mt-1.5 pl-2.5 border-l-2 text-[12px] leading-relaxed text-neutral-400 whitespace-pre-wrap"
          style={{ borderColor: `${accent}40` }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** Tools Phase — inline result card for a tool execution. */
function ToolResultCardView({ card, accent }: { card: ToolResultCard; accent: string }) {
  const [open, setOpen] = useState(false);
  const color = card.ok ? accent : "#ef4444";
  return (
    <div
      className="rounded-md border bg-black/30 px-3 py-2 text-[12px]"
      style={{ borderColor: `${color}55` }}
      data-testid="tool-result-card"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Wrench className="h-3.5 w-3.5" style={{ color }} />
        <span className="font-mono text-[11px]" style={{ color }}>
          {card.toolId}
        </span>
        <span className="text-neutral-300 flex-1 truncate">{card.summary}</span>
        {open ? (
          <ChevronDown className="h-3 w-3 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3 w-3 text-neutral-500" />
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {card.error && <div className="text-red-400 text-[11px]">{card.error}</div>}
          {card.data != null && (
            <pre className="text-[10px] text-neutral-400 bg-black/40 rounded p-2 overflow-x-auto max-h-60 whitespace-pre-wrap">
              {JSON.stringify(card.data, null, 2).slice(0, 4000)}
            </pre>
          )}
          {card.sources && card.sources.length > 0 && (
            <div className="text-[10px] text-neutral-500">
              {card.sources.slice(0, 5).map((s, i) => (
                <div key={i} className="truncate">
                  · {s}
                </div>
              ))}
            </div>
          )}
        </div>
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
          {/* Vision Phase 1 — image thumbnails attached to this user turn. */}
          {msg.images && msg.images.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {msg.images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt={`attachment ${i + 1}`}
                  className="h-20 w-20 object-cover rounded-md border border-neutral-600/60"
                />
              ))}
            </div>
          )}
          {msg.content}
        </div>
      </div>
    );
  }

  // Clean the assistant output for display:
  //   - strip <tool> control tags (the result card already shows what ran)
  //   - split internal reasoning into a collapsible panel (finalized turns
  //     only; while streaming we show raw tokens so the operator sees flow).
  const stripped = stripToolTags(msg.content);
  const { answer, reasoning } = msg.isStreaming
    ? { answer: stripped, reasoning: null as string | null }
    : splitReasoning(stripped);

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
                    // Cleaned answer: <tool> control tags stripped, internal
                    // reasoning split out (see ReasoningPanel below).
                    answer,
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
                {/* Reasoning panel — collapsible internal monologue, on
                    finalized turns only. Closed by default. */}
                {!msg.isStreaming && reasoning && (
                  <ReasoningPanel text={reasoning} accent={accent} />
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
                {/* Tools Phase — inline tool result cards. */}
                {msg.toolResults && msg.toolResults.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {msg.toolResults.map((t, i) => (
                      <ToolResultCardView key={i} card={t} accent={accent} />
                    ))}
                  </div>
                )}
                {/* Voice UX (2026-05-27): PlayButton lives BELOW the
                    message body now. Big teal "▶ Speak" button — see
                    components/voice/PlayButton.tsx header for the
                    why-it-was-invisible note. Self-hides if TTS isn't
                    available or message is empty. */}
                {!msg.errored && !msg.isStreaming && answer.length > 0 && (
                  <PlayButton
                    text={answer}
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
  // Phase 10 — research event tail. The chat route emits one of these
  // after the retrieval event on every turn.
  state?: "OFF" | "LIVE" | "CACHED" | "FAILED";
  intent?: string | null;
  quality?: string | null;
  confidence?: number | null;
  cachedAt?: string | null;
  // Phase 9 (router) — routing event (leading frame). Suggestion only.
  recommended?: string | null;
  currentPersona?: string | null;
  complexity?: "low" | "high";
  surface?: boolean;
  // Vision Phase 1 — vision event (leading frame). `model` = the model that
  // handled this turn; `used` = whether image routing engaged.
  model?: string;
  used?: boolean;
  // Memory Phase — memory event (leading frame). factsFound = relevant facts
  // recalled this turn; injected = whether a recall block was added.
  factsFound?: number;
  injected?: boolean;
  // Stage 4 — backend event (leading frame). backend = local|nous; model is
  // declared above; fallbackReason = any silent-fallback reason.
  backend?: string;
  fallbackReason?: string | null;
  // Tools Phase — tool_result + tool_approval_required frames. (`error` is
  // already declared above for Ollama errors; reuse it.)
  ok?: boolean;
  toolId?: string;
  summary?: string;
  sources?: string[] | null;
  data?: unknown;
  approvalId?: string;
  tool?: string;
  description?: string;
  risks?: string;
  reversible?: boolean;
  plan?: ToolPlanStep[] | null;
}

export function ChatPane() {
  const messages = useArgos((s) => s.messages);
  const isStreaming = useArgos((s) => s.isStreaming);
  const currentModel = useArgos((s) => s.currentModel);
  const currentPersonaId = useArgos((s) => s.currentPersonaId);
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
  // Vision Phase 1 — images staged for the next message + transient attach
  // errors (oversize/unsupported/over-cap). attachError auto-clears.
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Tools Phase — pending dangerous-tool approval (drives the modal dialog)
  // and the per-turn accumulator of tool result cards.
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalReq | null>(null);
  const turnToolsRef = useRef<ToolResultCard[]>([]);
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

  // Vision Phase 1 — image attach/screenshot/remove handlers. Cap at
  // MAX_IMAGES; surface validation errors transiently.
  const flashAttachError = useCallback((msg: string) => {
    setAttachError(msg);
    window.setTimeout(() => setAttachError(null), 5000);
  }, []);
  const addImages = useCallback(
    (imgs: AttachedImage[]) => {
      setAttachedImages((prev) => {
        const next = [...prev, ...imgs].slice(0, MAX_IMAGES);
        if (prev.length + imgs.length > MAX_IMAGES) {
          flashAttachError(`Only ${MAX_IMAGES} images per message.`);
        }
        return next;
      });
    },
    [flashAttachError]
  );
  const removeImage = useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((i) => i.id !== id));
  }, []);

  // Tools Phase — resolve a pending approval (APPROVE/DENY/timeout). On approve
  // the executor runs the tool (restore point first if required) and returns
  // the result; on deny we record the non-execution. Append the outcome as a
  // tool card on the current assistant message.
  const appendToolCard = useCallback((card: ToolResultCard) => {
    const msgs = useArgos.getState().messages;
    const last = msgs[msgs.length - 1];
    const prior = last?.toolResults ?? [];
    patchLastMessage({ toolResults: [...prior, card] });
  }, [patchLastMessage]);

  const resolveApproval = useCallback(
    async (decision: "approve" | "deny") => {
      const req = pendingApproval;
      setPendingApproval(null);
      if (!req) return;
      if (decision === "deny") {
        appendToolCard({
          toolId: req.toolId,
          ok: false,
          summary: "denied by operator",
          error: "operator denied the tool",
        });
        return;
      }
      try {
        // Phase 1.5 — /api/tools/approve is session-gated (Rule 8): attach
        // the operator bearer, same as the chat request path.
        const approveHeaders: Record<string, string> = {
          "content-type": "application/json",
        };
        const sessTok = getSessionToken();
        if (sessTok) approveHeaders["authorization"] = `Bearer ${sessTok}`;
        const r = await fetch("/api/tools/approve", {
          method: "POST",
          headers: approveHeaders,
          body: JSON.stringify({ approvalId: req.approvalId, decision: "approve" }),
        });
        const j = (await r.json()) as { result?: ToolResultCard | null };
        if (j.result) {
          appendToolCard({
            toolId: j.result.toolId ?? req.toolId,
            ok: j.result.ok === true,
            summary: j.result.summary ?? "",
            data: j.result.data ?? null,
            sources: j.result.sources ?? null,
            error: j.result.error ?? null,
          });
        }
      } catch (e) {
        appendToolCard({
          toolId: req.toolId,
          ok: false,
          summary: "approval request failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [pendingApproval, appendToolCard]
  );

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
    // Vision Phase 1 — images only ride on textarea-driven sends, never on
    // programmatic ones (Bobby's Reject). Captured before the early-return so
    // an image-only message (no text) can still go.
    const imagesAtSend =
      overrideText === undefined ? attachedImages.map((a) => a.dataUrl) : [];
    const typed = (overrideText ?? draft).trim();
    if ((!typed && imagesAtSend.length === 0) || isStreaming) return;
    // Give an image-only message a sensible default prompt so the model has
    // something to answer; still shown verbatim in the transcript.
    const text =
      typed || (imagesAtSend.length > 0 ? "What's in this image?" : "");

    const snapshot = useArgos.getState().messages;
    const personaIdAtSend = useArgos.getState().currentPersonaId;
    const modelAtSend = useArgos.getState().currentModel;
    const useRetrieval = useArgos.getState().vaultStatus.docs > 0;

    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      images: imagesAtSend.length > 0 ? imagesAtSend : undefined,
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
    if (overrideText === undefined) {
      setDraft("");
      setAttachedImages([]);
      setAttachError(null);
    }
    setStreaming(true);
    // Tools Phase — fresh tool-result accumulator for this turn.
    turnToolsRef.current = [];

    // Wire history: prior turns are text-only (bound payload); only the
    // current user turn carries images, in Ollama's native `images` field.
    // v2.3.9 — assistant turns also carry the tool results the operator saw, so
    // the route can surface them to the model (root-cause of "I await the
    // result") and run the misrepresentation guard. Compact: toolId/ok/summary/
    // error/data only (NOT sources). NOT forwarded to Ollama by the route.
    const wireHistory = [
      ...snapshot.map((m) =>
        m.role === "assistant" && Array.isArray(m.toolResults) && m.toolResults.length > 0
          ? {
              role: m.role,
              content: m.content,
              toolResults: m.toolResults.map((t) => ({
                toolId: t.toolId,
                ok: t.ok,
                summary: t.summary,
                error: t.error ?? null,
                data: t.data ?? null,
              })),
            }
          : { role: m.role, content: m.content }
      ),
      imagesAtSend.length > 0
        ? { role: userMsg.role, content: text, images: imagesAtSend }
        : { role: userMsg.role, content: text },
    ];

    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let liveTokenCount = 0;

    // Fresh AbortController per send so the Stop button can cancel
    // just this request without touching anything else.
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Operator Auth — attach the bearer token if present in
      // sessionStorage. No-op when running with requirePin=false: the
      // server treats every request as operator anyway.
      const chatHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      const token = getSessionToken();
      if (token) chatHeaders["authorization"] = `Bearer ${token}`;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify({
          messages: wireHistory,
          personaId: personaIdAtSend,
          model: modelAtSend,
          useRetrieval,
          truthMode: useArgos.getState().truthMode,
          // Phase 3 — session id for the observation corpus (capture-only).
          sessionId: useArgos.getState().currentSessionId,
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
            if (data?.type === "research") {
              // Phase 10 — update the HUD's research row from this
              // turn's research event. Always fires — OFF when no
              // research was attempted.
              useArgos.getState().setResearchState({
                state: data.state ?? "OFF",
                intent: data.intent ?? null,
                quality: data.quality ?? null,
                confidence: data.confidence ?? null,
                cachedAt: data.cachedAt ?? null,
              });
              continue;
            }
            if (data?.type === "routing") {
              // Phase 9 (router) — suggestion only. The chat route
              // emits this as the FIRST frame. We record it for the
              // HUD; we NEVER auto-switch the persona (manual choice
              // always wins). The HUD shows "Routing to X" only when
              // surface===true (cleared the gate AND differs from the
              // active persona).
              useArgos.getState().setRoutingSuggestion({
                recommended: (data.recommended as PersonaId | null) ?? null,
                confidence: data.confidence ?? 0,
                currentPersona:
                  (data.currentPersona as PersonaId | null) ?? null,
                complexity: data.complexity ?? "low",
                surface: data.surface === true,
              });
              continue;
            }
            if (data?.type === "vision") {
              // Vision Phase 1 — record the model that handled this turn so
              // the HUD shows it. null when the turn was text-only.
              useArgos
                .getState()
                .setVisionModel(data.used && data.model ? data.model : null);
              continue;
            }
            if (data?.type === "memory") {
              // Memory Phase — record how much cross-session context was
              // recalled this turn for the HUD "Memory" row.
              useArgos.getState().setMemory({
                factsFound: data.factsFound ?? 0,
                injected: data.injected === true,
              });
              continue;
            }
            if (data?.type === "backend") {
              // Stage 4 — record the LIVE inference source (backend + exact
              // model + any fallback) so the HUD "Model" row shows what actually
              // answered, not the static persona binding.
              useArgos.getState().setInference({
                backend: typeof data.backend === "string" ? data.backend : "local",
                model: typeof data.model === "string" ? data.model : "",
                fallbackReason: typeof data.fallbackReason === "string" ? data.fallbackReason : null,
              });
              continue;
            }
            if (data?.type === "tool_result") {
              // Tools Phase — a safe tool ran (or an approved one returned).
              const card: ToolResultCard = {
                toolId: data.toolId ?? "tool",
                ok: data.ok === true,
                summary: data.summary ?? "",
                data: data.data ?? null,
                sources: data.sources ?? null,
                error: data.error ?? null,
              };
              turnToolsRef.current = [...turnToolsRef.current, card];
              patchLastMessage({ toolResults: [...turnToolsRef.current] });
              continue;
            }
            if (data?.type === "tool_approval_required") {
              // Tools Phase — a dangerous tool needs operator confirmation.
              setPendingApproval({
                approvalId: data.approvalId ?? "",
                toolId: data.toolId ?? "",
                tool: data.tool ?? data.toolId ?? "tool",
                description: data.description ?? "",
                risks: data.risks ?? "",
                reversible: data.reversible === true,
                plan: Array.isArray(data.plan) ? data.plan : undefined,
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
              images: m.images,
              toolResults: m.toolResults,
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
    attachedImages,
    isStreaming,
    appendMessage,
    appendToLastMessage,
    patchLastMessage,
    setStreaming,
    setHudMetric,
    pushLatency,
  ]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter (or Cmd/Ctrl+Enter) sends; Shift+Enter inserts a newline. Ignore
    // Enter while an IME composition is in progress (CJK/voice etc).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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

  // Phase 7-D: caveman conversation mode — voice loop (mic → send → Bart
  // speaks → mic). send() already supports programmatic text.
  const conversation = useConversationMode({
    messages,
    isStreaming,
    personaId: currentPersonaId,
    sendText: (t) => void send(t),
  });
  const convoActiveRef = useRef(false);
  convoActiveRef.current = conversation.active;
  const convoStopRef = useRef(conversation.stop);
  convoStopRef.current = conversation.stop;

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
      // Esc ALWAYS exits conversation mode first (per directive — must be
      // stoppable). Fires regardless of streaming state.
      if (e.key === "Escape" && !mod && convoActiveRef.current) {
        e.preventDefault();
        convoStopRef.current();
        return;
      }
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
        {/* Phase 7-D: conversation ("caveman") mode toggle. Self-hides when
            the Web Speech API is unavailable. */}
        {conversation.supported && (
          <button
            type="button"
            onClick={conversation.toggle}
            title={
              conversation.active
                ? "Stop conversation mode (Esc)"
                : "Conversation mode — talk back and forth with voice"
            }
            aria-label="Toggle conversation mode"
            aria-pressed={conversation.active}
            className={
              "rounded p-1.5 transition-colors " +
              (conversation.active
                ? "text-[#00ff9d] bg-[#00ff9d]/15"
                : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60")
            }
          >
            <Radio
              className={"h-3.5 w-3.5 " + (conversation.active ? "animate-pulse" : "")}
            />
          </button>
        )}
        {/* Vision Phase 1 — screenshot capture (getDisplayMedia). Self-hides
            where unsupported; capture appears as a composer image preview. */}
        <ScreenshotButton
          onCapture={(img) => addImages([img])}
          onError={(msg) => flashAttachError(msg)}
          disabled={isStreaming}
          atCapacity={attachedImages.length >= MAX_IMAGES}
        />
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
      {/* Tools Phase — governance approval gate (modal, 60s auto-deny). */}
      {pendingApproval && (
        <ToolApprovalDialog req={pendingApproval} onResolve={resolveApproval} />
      )}
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
              Enter to send, Shift+Enter for newline.
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
          {/* Phase 7-D: conversation-mode status banner. */}
          {conversation.active && (
            <div
              className="mb-2 flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.18em]"
              style={{ color: "#00ff9d" }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full animate-pulse"
                style={{
                  background: conversation.phase === "listening" ? "#ef4444" : "#00ff9d",
                }}
              />
              Conversation Active
              <span className="text-neutral-500 normal-case tracking-normal">
                ·{" "}
                {conversation.phase === "speaking"
                  ? "Bartimaeus speaking…"
                  : conversation.phase === "listening"
                    ? "listening…"
                    : "thinking…"}{" "}
                · Esc to stop
              </span>
            </div>
          )}
          {/* Vision Phase 1 — staged image previews + transient attach error. */}
          <ImagePreviewStrip
            images={attachedImages}
            onRemove={removeImage}
            accent={accent}
          />
          {attachError && (
            <div className="mb-2 text-[11px] text-amber-400" role="alert">
              {attachError}
            </div>
          )}
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
                  : `Message ${personaName} (Enter to send, Shift+Enter for newline)`
              }
              className="w-full resize-none bg-neutral-900/60 border border-neutral-800 rounded-md pl-4 pr-60 py-3 text-[13px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700 disabled:opacity-60"
            />
            {/* Audio OUTPUT routing — self-hides when only one
                output device exists. Persists choice to localStorage;
                consumed by PlayButton via AudioContext.setSinkId().
                Sits above the mic device selector in the same column. */}
            <SpeakerSelect accent={accent} disabled={isStreaming} />
            {/* Phase 7-D: Web Speech API mic (left of Send). Self-hides when
                the browser lacks SpeechRecognition. Dictated text is appended
                to the draft so the operator can edit before sending. Disabled
                during streaming + conversation mode (which drives its own mic). */}
            <SpeechMicButton
              accent={accent}
              disabled={isStreaming || conversation.active}
              onTranscript={(text) =>
                setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
              }
            />
            {/* Vision Phase 1 — image attach (left of the mic). */}
            <ImageDropButton
              accent={accent}
              disabled={isStreaming || conversation.active}
              currentCount={attachedImages.length}
              onAttach={addImages}
              onError={(errs) => flashAttachError(errs.join(" "))}
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
                disabled={draft.trim().length === 0 && attachedImages.length === 0}
                className="absolute right-1.5 bottom-1.5 rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed"
                style={{
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor:
                    !draft.trim() && attachedImages.length === 0 ? "#404040" : accent,
                  color:
                    !draft.trim() && attachedImages.length === 0 ? "#737373" : accent,
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
