// components/voice/PlayButton.tsx
//
// Phase 5 — per-message TTS play button.
//
// Hidden if the server reports TTS unavailable. Visible on every
// completed (non-streaming, non-errored) assistant message. Clicking
// fetches the WAV, plays it; clicking again stops playback.
//
// Pre-emption: only one PlayButton can play at a time across the
// session — starting a new playback aborts any in-flight fetch +
// pauses any currently-playing audio. We coordinate via a tiny
// global registry rather than a context to avoid a re-render storm.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, Pause, Loader2, AlertCircle } from "lucide-react";
import { synthesizeToBlob } from "@/lib/voice-client";

// Cross-component "stop everyone else" coordination. Each PlayButton
// registers itself when it starts and unregisters when it stops. A
// new start calls stop() on whoever is currently registered. Lives
// at module scope — single browser window, no SSR concerns.
let currentlyPlaying: { stop: () => void } | null = null;

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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
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
        const j = (await r.json()) as { tts?: { available?: boolean } };
        if (!cancelled) setAvailable(!!j.tts?.available);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hard stop — used both by the user clicking pause and by a
  // sibling button taking over playback. Releases all resources.
  const hardStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
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

  const start = useCallback(async () => {
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
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        // Natural finish — clean up but stay mounted.
        hardStop();
      };
      audio.onerror = () => {
        setState("error");
        setErrMsg("audio playback failed");
        window.setTimeout(() => setState("idle"), 2500);
      };
      await audio.play();
      // play() resolves once playback has actually started.
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
  }, [text, sessionId, personaId, hardStop]);

  if (available === null) return null;
  if (!available) return null;
  if (!text.trim()) return null;

  const title =
    state === "error" && errMsg
      ? `voice error — ${errMsg}`
      : state === "playing"
        ? "stop playback"
        : state === "loading"
          ? "synthesizing…"
          : "play this message";

  return (
    <button
      type="button"
      onClick={() => (state === "playing" ? hardStop() : void start())}
      disabled={state === "loading"}
      title={title}
      aria-label={title}
      className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-200 transition-colors disabled:opacity-50"
      style={{
        color:
          state === "error"
            ? "#ef4444"
            : state === "playing"
              ? accent
              : undefined,
      }}
    >
      {state === "loading" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state === "error" ? (
        <AlertCircle className="h-3 w-3" />
      ) : state === "playing" ? (
        <Pause className="h-3 w-3" />
      ) : (
        <Volume2 className="h-3 w-3" />
      )}
    </button>
  );
}
