// lib/useConversationMode.ts
//
// Phase 7-D — "caveman mode" voice conversation loop.
//
// When active:
//   user speaks → transcript auto-sent → Bart responds (streams) → his reply
//   auto-speaks → on speech end the mic re-arms → repeat.
// Entry: toggling ON unlocks audio (gesture) and arms the mic so the operator
// speaks first. Stop: toggle again OR press Escape (wired in ChatPane) — always
// exits, stops the mic, and aborts any in-progress speech.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSpeechRecognizer,
  speakText,
  stopSpeaking,
  unlockAudioContext,
  speechRecognitionSupported,
  type Recognizer,
} from "./voice-speech";

interface Msg {
  id: string;
  role: string;
  isStreaming?: boolean;
  errored?: boolean;
  content: string;
  personaId?: string;
}

export type ConvoPhase = "idle" | "listening" | "speaking";

export function useConversationMode(opts: {
  messages: Msg[];
  isStreaming: boolean;
  personaId: string;
  sendText: (t: string) => void;
}) {
  const { messages, isStreaming } = opts;
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<ConvoPhase>("idle");

  const activeRef = useRef(false);
  const recRef = useRef<Recognizer | null>(null);
  const spokenIdRef = useRef<string | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);
  const sendRef = useRef(opts.sendText);
  sendRef.current = opts.sendText;
  const personaRef = useRef(opts.personaId);
  personaRef.current = opts.personaId;

  const supported =
    typeof window !== "undefined" && speechRecognitionSupported();

  const startMic = useCallback(() => {
    if (!activeRef.current) return;
    if (!recRef.current) {
      recRef.current = createSpeechRecognizer({
        onFinal: (t) => {
          if (activeRef.current && t.trim()) sendRef.current(t.trim());
        },
        onListeningChange: (l) => {
          if (activeRef.current) setPhase(l ? "listening" : "idle");
        },
      });
    }
    recRef.current.start();
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setPhase("idle");
    recRef.current?.stop();
    speakAbortRef.current?.abort();
    stopSpeaking();
  }, []);

  const toggle = useCallback(() => {
    if (activeRef.current) {
      stop();
      return;
    }
    if (!supported) return;
    unlockAudioContext(); // gesture unlock so later programmatic speech plays
    activeRef.current = true;
    setActive(true);
    // Don't re-speak existing history — mark the current last message handled.
    const last = opts.messages[opts.messages.length - 1];
    spokenIdRef.current = last ? last.id : null;
    startMic();
  }, [supported, startMic, stop, opts.messages]);

  // When a NEW assistant message finalizes, speak it then re-arm the mic.
  useEffect(() => {
    if (!active || isStreaming) return;
    const last = messages[messages.length - 1];
    if (
      !last ||
      last.role !== "assistant" ||
      last.isStreaming ||
      last.errored ||
      !last.content.trim()
    )
      return;
    if (last.id === spokenIdRef.current) return;
    spokenIdRef.current = last.id;

    recRef.current?.stop(); // don't listen to ourselves
    const ac = new AbortController();
    speakAbortRef.current = ac;
    setPhase("speaking");
    void speakText(last.content, {
      personaId: last.personaId ?? personaRef.current,
      signal: ac.signal,
    })
      .catch(() => {})
      .finally(() => {
        if (activeRef.current) startMic();
        else setPhase("idle");
      });
  }, [messages, active, isStreaming, startMic]);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      recRef.current?.stop();
      stopSpeaking();
    },
    []
  );

  return { active, supported, phase, toggle, stop };
}
