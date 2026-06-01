// components/voice/SpeechMicButton.tsx
//
// Phase 7-D — browser-native mic (Web Speech API). Sits left of Send.
//   click  → start listening (red pulsing indicator)
//   click again OR 2s silence → stop; final transcript → onTranscript()
// Self-hides when the Web Speech API is unavailable (e.g. Firefox). No
// Whisper, no server round-trip, no new deps.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { createSpeechRecognizer, speechRecognitionSupported, type Recognizer } from "@/lib/voice-speech";

interface SpeechMicButtonProps {
  /** Receives the final transcript when recording stops. */
  onTranscript: (text: string) => void;
  /** Disable (e.g. while streaming or in conversation mode). */
  disabled?: boolean;
  /** Persona accent for the active glow. */
  accent?: string;
}

export function SpeechMicButton({ onTranscript, disabled, accent = "#00ff9d" }: SpeechMicButtonProps) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<Recognizer | null>(null);

  useEffect(() => {
    setSupported(speechRecognitionSupported());
  }, []);

  // (Re)create the recognizer when the transcript handler changes.
  useEffect(() => {
    if (!speechRecognitionSupported()) return;
    recRef.current = createSpeechRecognizer({
      onFinal: (t) => onTranscript(t),
      onListeningChange: setListening,
    });
    return () => {
      recRef.current?.stop();
      recRef.current = null;
    };
  }, [onTranscript]);

  // If disabled mid-listen, stop.
  useEffect(() => {
    if (disabled && listening) recRef.current?.stop();
  }, [disabled, listening]);

  const onClick = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (rec.isListening()) rec.stop();
    else rec.start();
  }, []);

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={listening ? "Stop dictation (or pause 2s)" : "Dictate (Web Speech)"}
      aria-label={listening ? "Stop dictation" : "Start dictation"}
      data-mic-state={listening ? "listening" : "idle"}
      className="absolute bottom-1.5 right-[88px] inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        borderColor: listening ? "#ef4444" : `${accent}55`,
        color: listening ? "#ef4444" : accent,
        background: listening ? "rgba(239,68,68,0.12)" : "rgba(0,0,0,0.35)",
      }}
    >
      <Mic className={`h-4 w-4 ${listening ? "animate-pulse" : ""}`} />
      {listening && (
        <span
          className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full"
          style={{ background: "#ef4444", boxShadow: "0 0 6px #ef4444" }}
        />
      )}
    </button>
  );
}
