// components/voice/MicButton.tsx
//
// Phase 5 — composer mic button.
//
// Three visible states (no recording / recording / transcribing).
// Hidden entirely if the server reports STT not available — the
// operator never sees a button that doesn't work.
//
// Tap-to-start, tap-to-stop UX. Held-to-record was considered but
// rejected: on a laptop trackpad it's awkward, and the "tap-start /
// tap-stop" model lets the operator pause to compose a sentence
// without losing the buffer.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Loader2, MicOff } from "lucide-react";
import {
  startVoiceRecorder,
  transcribeBlob,
  type RecorderHandle,
} from "@/lib/voice-client";

interface MicButtonProps {
  /** Called with the transcribed text when STT completes. */
  onTranscribed: (text: string) => void;
  /** Optional sessionId for audit-chain scoping. */
  sessionId?: string;
  /** Disable while the chat composer is otherwise busy. */
  disabled?: boolean;
  /** Accent color from the active persona. */
  accent: string;
}

type State =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "transcribing" }
  | { kind: "error"; message: string };

// Hard cap so we never hold an open mic forever if the operator
// walks away. 60s matches whisper.cpp's typical comfortable batch.
const MAX_RECORDING_MS = 60_000;

export function MicButton({
  onTranscribed,
  sessionId,
  disabled,
  accent,
}: MicButtonProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);

  // Recorder + abort handles need to survive re-renders.
  const recorderRef = useRef<RecorderHandle | null>(null);
  const sttAbortRef = useRef<AbortController | null>(null);
  const tickRef = useRef<number | null>(null);

  // Capability probe on mount. Polls again if the user enables voice
  // later (caught by the periodic refresh in the parent — Phase 5
  // doesn't ship a Settings toggle yet, so a refetch on next mount
  // is the recovery path).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/voice/status", { cache: "no-store" });
        if (!r.ok) {
          if (!cancelled) setAvailable(false);
          return;
        }
        const j = (await r.json()) as { stt?: { available?: boolean } };
        if (!cancelled) setAvailable(!!j.stt?.available);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Tick the elapsed counter while recording.
  useEffect(() => {
    if (state.kind !== "recording") {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    setElapsed(0);
    tickRef.current = window.setInterval(() => {
      setElapsed(Date.now() - state.startedAt);
    }, 200) as unknown as number;
    return () => {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [state]);

  // Safety: if recording exceeds MAX_RECORDING_MS, auto-stop.
  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = window.setTimeout(() => {
      if (recorderRef.current) {
        void stop();
      }
    }, MAX_RECORDING_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Unmount cleanup — cancel recorder + STT abort.
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      sttAbortRef.current?.abort();
    };
  }, []);

  const start = useCallback(async () => {
    if (disabled) return;
    try {
      const handle = await startVoiceRecorder();
      recorderRef.current = handle;
      setState({ kind: "recording", startedAt: Date.now() });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      // Reset to idle after a moment so the operator can retry.
      window.setTimeout(() => setState({ kind: "idle" }), 2500);
    }
  }, [disabled]);

  const stop = useCallback(async () => {
    const handle = recorderRef.current;
    recorderRef.current = null;
    if (!handle) return;
    setState({ kind: "transcribing" });
    try {
      const wav = await handle.stop();
      const controller = new AbortController();
      sttAbortRef.current = controller;
      try {
        const text = await transcribeBlob(wav, {
          sessionId,
          signal: controller.signal,
        });
        if (text) onTranscribed(text);
        setState({ kind: "idle" });
      } finally {
        sttAbortRef.current = null;
      }
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      window.setTimeout(() => setState({ kind: "idle" }), 3500);
    }
  }, [onTranscribed, sessionId]);

  // Don't render anything until we know whether voice is available.
  // null state == probe-in-flight (still mounting); false == hide.
  if (available === null) return null;
  if (!available) return null;

  const isRecording = state.kind === "recording";
  const isTranscribing = state.kind === "transcribing";
  const isError = state.kind === "error";

  const title = isError
    ? `voice error — ${state.message}`
    : isRecording
      ? `recording (${(elapsed / 1000).toFixed(1)}s) — click to stop`
      : isTranscribing
        ? "transcribing…"
        : "voice input — click to record";

  return (
    <button
      type="button"
      onClick={() => {
        if (isRecording) void stop();
        else if (!isTranscribing && !isError) void start();
      }}
      disabled={disabled || isTranscribing}
      title={title}
      aria-label={title}
      className="absolute right-[5.5rem] bottom-1.5 rounded-md p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        color: isError
          ? "#ef4444"
          : isRecording
            ? "#ef4444"
            : isTranscribing
              ? accent
              : undefined,
      }}
    >
      {isTranscribing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : isError ? (
        <MicOff className="h-4 w-4" />
      ) : isRecording ? (
        // Pulsing red mic during recording — clear "yes, I'm listening".
        <Mic className="h-4 w-4 animate-pulse" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </button>
  );
}
