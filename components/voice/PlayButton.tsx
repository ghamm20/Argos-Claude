// components/voice/PlayButton.tsx
//
// Phase 5 — per-message TTS play button.
// Phase 7 hotfix (2026-05-26) — switched playback from HTMLAudioElement
// to Web Audio API (AudioContext + BufferSourceNode).
//
// Why: Chrome's autoplay policy suspends any AudioContext (and silently
// blocks `new Audio(url).play()`) when the call chain to playback isn't
// rooted in a synchronous user gesture. The previous implementation did
// `await synthesizeToBlob(...)` BEFORE creating the audio element, so
// by the time `.play()` ran, the gesture chain was broken — playback
// promise resolved but no sound emerged (or it was outright rejected
// on some Chrome builds). curl-confirmed the WAV bytes were fine.
//
// Fix: in onClick we synchronously create/resume the AudioContext
// FIRST (still inside the gesture callstack), then kick off the async
// fetch+decode+play. Once a context is unlocked, subsequent decodes
// on that same context don't need a fresh gesture.
//
// Pre-emption: only one PlayButton can play at a time across the
// session — starting a new playback aborts any in-flight fetch +
// stops the currently-playing source. We coordinate via a tiny
// module-scope registry rather than a context to avoid a re-render storm.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, Pause, Loader2, AlertCircle } from "lucide-react";
import { synthesizeToBlob, getPersistedSpeakerId } from "@/lib/voice-client";

// Module-scope flag to suppress repeated "setSinkId unsupported"
// console warnings — log it once per page load, not once per click.
let setSinkIdUnsupportedLogged = false;

/**
 * AudioContext with the (Chrome 110+) `setSinkId` method. The Web Audio
 * spec adds setSinkId to BaseAudioContext but the lib.dom.d.ts TypeScript
 * types haven't caught up everywhere, so we narrow with a structural
 * type instead of relying on the runtime AudioContext type.
 */
type ContextWithSetSinkId = AudioContext & {
  setSinkId: (deviceId: string) => Promise<void>;
};

// Cross-component "stop everyone else" coordination. Each PlayButton
// registers itself when it starts and unregisters when it stops. A
// new start calls stop() on whoever is currently registered. Lives
// at module scope — single browser window, no SSR concerns.
let currentlyPlaying: { stop: () => void } | null = null;

// Module-scope shared AudioContext. Created lazily inside a user
// gesture so Chrome's autoplay policy keeps it in the "running"
// state. Reused across all PlayButtons in the page — Web Audio
// supports many concurrent BufferSources on a single context, and
// some browsers cap total AudioContext count per origin so sharing
// is the safe default.
let sharedCtx: AudioContext | null = null;

/**
 * Create (or return the existing) shared AudioContext. MUST be called
 * synchronously from a user-gesture handler the first time it runs
 * in a page, otherwise Chrome will mark it "suspended" and any
 * subsequent .start() on a BufferSource will be silent.
 *
 * Throws if Web Audio isn't available (very old browsers / non-window
 * environments) — the caller surfaces a UI error in that case.
 */
function getSharedAudioContext(): AudioContext {
  if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
  const Ctor: typeof AudioContext =
    window.AudioContext ||
    // Safari + older Chrome
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext not supported in this browser");
  sharedCtx = new Ctor();
  return sharedCtx;
}

interface PlayButtonProps {
  /** The text to speak. Trimmed before send; empty text yields no button. */
  text: string;
  /** Persona accent for the idle button color. */
  accent: string;
  /** Optional sessionId for audit-chain scoping. */
  sessionId?: string;
  /** Phase 7: persona id so the TTS route can pick the right voice. */
  personaId?: string;
}

type State = "idle" | "loading" | "playing" | "error";

export function PlayButton({ text, accent, sessionId, personaId }: PlayButtonProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [state, setState] = useState<State>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/voice/status", { cache: "no-store" });
        if (!r.ok) {
          if (!cancelled) setAvailable(false);
          return;
        }
        const j = (await r.json()) as {
          tts?: { available?: boolean };
          f5?: { available?: boolean };
        };
        // Phase 7-C: Bartimaeus can speak via the F5-TTS clone even when
        // Piper is absent. So the Speak button shows if Piper/Kokoro is
        // available (any persona) OR — for Bartimaeus — F5 is available.
        const ttsOk = !!j.tts?.available;
        const f5Ok = !!j.f5?.available;
        const isBart = (personaId ?? "").toLowerCase() === "bartimaeus";
        // Bartimaeus speaks if F5 (the clone) OR Piper is available; everyone
        // else needs Piper/Kokoro. CLI detection is enough — no daemon needed.
        const canSpeak = isBart ? ttsOk || f5Ok : ttsOk;
        if (!cancelled) setAvailable(canSpeak);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [personaId]);

  // Hard stop — used both by the user clicking pause and by a
  // sibling button taking over playback. Releases all resources
  // EXCEPT the shared AudioContext (other PlayButtons may need it,
  // and re-creating it would re-trigger the autoplay-policy dance).
  const hardStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        /* already stopped — Web Audio throws InvalidStateError */
      }
      try {
        sourceRef.current.disconnect();
      } catch {
        /* idempotent best-effort */
      }
      sourceRef.current = null;
    }
    if (currentlyPlaying && currentlyPlaying.stop === hardStop) {
      currentlyPlaying = null;
    }
    setState("idle");
  }, []);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      hardStop();
    };
  }, [hardStop]);

  // Async portion of playback — runs AFTER the AudioContext was
  // unlocked on the synchronous click. Safe to await freely here.
  const start = useCallback(
    async (ctx: AudioContext) => {
      // Cooperate with any other playing instance.
      if (currentlyPlaying) currentlyPlaying.stop();
      currentlyPlaying = { stop: hardStop };

      setState("loading");
      setErrMsg(null);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const blob = await synthesizeToBlob(text, {
          sessionId,
          personaId,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        const arrayBuf = await blob.arrayBuffer();
        if (controller.signal.aborted) return;

        // decodeAudioData wants a fresh ArrayBuffer (it transfers
        // ownership in some implementations). slice(0) is a defensive
        // copy — cheap relative to the network fetch we just did.
        const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
        if (controller.signal.aborted) return;

        // Voice UX (2026-05-27): route to the operator-selected output
        // device if one is persisted. setSinkId moves the context's
        // destination to the chosen sink — fixes the case where the
        // OS default output is a virtual sink (DeskIn, VB-Cable, etc.)
        // and the WAV would otherwise vanish into the void.
        //
        // Failure modes (all non-fatal — fall through to default sink):
        //   - setSinkId not on the prototype → older browser, log once
        //   - persisted device id gone (unplugged headphones) → throws
        //   - permission denied / device busy → throws
        // In each case we still want playback to proceed on whatever
        // sink Chrome would have used anyway.
        const speakerId = getPersistedSpeakerId();
        if (speakerId) {
          const ctxAny = ctx as Partial<ContextWithSetSinkId>;
          if (typeof ctxAny.setSinkId === "function") {
            try {
              await (ctxAny as ContextWithSetSinkId).setSinkId(speakerId);
            } catch (err) {
              // Surface a warning but keep playing on the default sink.
              // Most common cause: persisted device was unplugged.
              // eslint-disable-next-line no-console
              console.warn(
                `[PlayButton] setSinkId failed (falling back to default sink):`,
                err
              );
            }
          } else if (!setSinkIdUnsupportedLogged) {
            setSinkIdUnsupportedLogged = true;
            // eslint-disable-next-line no-console
            console.warn(
              "[PlayButton] AudioContext.setSinkId is not supported in this browser — output routing will use the OS default sink. Chrome 110+ is required."
            );
          }
        }
        if (controller.signal.aborted) return;

        const source = ctx.createBufferSource();
        source.buffer = audioBuf;
        source.connect(ctx.destination);
        source.onended = () => {
          // Natural finish — only clean up if this is still the
          // active source (a new start() may have replaced us).
          if (sourceRef.current === source) hardStop();
        };
        sourceRef.current = source;
        source.start(0);
        setState("playing");
      } catch (e) {
        // AbortError is a controlled stop — not a UI error.
        if (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message))) {
          return;
        }
        setState("error");
        setErrMsg(e instanceof Error ? e.message : String(e));
        window.setTimeout(() => setState("idle"), 3500);
      }
    },
    [text, sessionId, personaId, hardStop]
  );

  // The click handler MUST stay synchronous up to and including the
  // ctx.resume() call — that's what satisfies Chrome's gesture
  // requirement. Any `await` before resume() breaks the chain.
  const onClick = useCallback(() => {
    if (state === "playing") {
      hardStop();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = getSharedAudioContext();
    } catch (e) {
      setState("error");
      setErrMsg(e instanceof Error ? e.message : "audio init failed");
      window.setTimeout(() => setState("idle"), 3500);
      return;
    }
    // Resume if the browser created the context in "suspended" state
    // or if it was auto-suspended after inactivity. resume() returns
    // a Promise but the unlock takes effect immediately for the
    // purposes of the gesture — we don't need to await it here.
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        /* If resume fails the start() call below will surface it */
      });
    }
    void start(ctx);
  }, [state, hardStop, start]);

  if (available === null) return null;
  if (!available) return null;
  if (!text.trim()) return null;

  // Visible-label states. The previous design was a 20×20-px icon with
  // a 12-px speaker glyph in `text-neutral-500` — technically present
  // but invisible against the dark bubble background. Operator
  // confirmed they couldn't find it. New design: full-text button,
  // ARGOS teal background, dark text, ≥32-px tall.
  const title =
    state === "error" && errMsg
      ? `voice error — ${errMsg}`
      : state === "playing"
        ? "stop playback"
        : state === "loading"
          ? "synthesizing…"
          : "play this message";

  const label =
    state === "loading"
      ? "Synthesizing…"
      : state === "playing"
        ? "Stop"
        : state === "error"
          ? "Audio error"
          : "Speak";

  // ARGOS theme teal. Hard-coded rather than tied to persona.accentColor
  // so the button is consistently recognizable across personas (Bart
  // green, Juniper lime, Sage yellow, Bobby blue all collapsed to a
  // single "voice action" color). The `accent` prop is still honored
  // for the loading state's spinner ring + the playing/error glyph
  // tints — those track persona to keep some visual association.
  const ARGOS_TEAL = "#00ff9d";
  const isDisabled = state === "loading";
  const bgColor =
    state === "error"
      ? "rgba(239, 68, 68, 0.85)"
      : state === "playing"
        ? "rgba(0, 255, 157, 0.75)"
        : state === "loading"
          ? "rgba(0, 255, 157, 0.45)"
          : ARGOS_TEAL;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      aria-label={title}
      data-voice-state={state}
      className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium text-neutral-950 shadow-sm transition-colors disabled:cursor-not-allowed"
      style={{
        background: bgColor,
        // Subtle outline keeps the button visible even if a future
        // theme shift desaturates the bg color.
        outline: `1px solid ${accent}40`,
      }}
    >
      {state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : state === "error" ? (
        <AlertCircle className="h-4 w-4" />
      ) : state === "playing" ? (
        <Pause className="h-4 w-4" />
      ) : (
        <Volume2 className="h-4 w-4" />
      )}
      <span>{label}</span>
    </button>
  );
}
