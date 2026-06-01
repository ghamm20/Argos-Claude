// components/voice/VoiceStatusPanel.tsx
//
// Phase 7-D — live voice status for the Voice page. Replaces the old
// "disabled · coming v2" stub box. Three rows:
//   1. F5-TTS (Bartimaeus voice) — server-detected, passed in as props.
//   2. Mic input (Web Speech API) — detected in-browser on mount.
//   3. Conversation mode — available whenever the mic is (it drives the mic).
//
// Honest status only: each row shows green (live) / amber (unavailable) with
// the real reason, never a fake "ready".

"use client";

import { useEffect, useState } from "react";
import { Mic, Volume2, Radio } from "lucide-react";
import { speechRecognitionSupported } from "@/lib/voice-speech";

interface F5Props {
  available: boolean;
  reason?: string | null;
  device?: "cuda" | "cpu";
  daemonPort?: number;
}

type Level = "live" | "off";

function Dot({ level }: { level: Level }) {
  const color = level === "live" ? "#00ff9d" : "#f59e0b";
  return (
    <span
      className="inline-block h-2 w-2 rounded-full shrink-0"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}

function Row({
  icon,
  title,
  level,
  state,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  level: Level;
  state: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-neutral-800/70 bg-black/30 px-4 py-3">
      <span className="mt-0.5 text-neutral-500">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-neutral-200">{title}</span>
          <Dot level={level} />
          <span
            className="text-[10px] uppercase tracking-[0.18em]"
            style={{ color: level === "live" ? "#00ff9d" : "#f59e0b" }}
          >
            {state}
          </span>
        </div>
        <div className="text-[12px] leading-relaxed text-neutral-500 mt-1">
          {detail}
        </div>
      </div>
    </div>
  );
}

export function VoiceStatusPanel({ f5 }: { f5: F5Props }) {
  // Web Speech API support is a browser fact — detect after mount to avoid
  // an SSR/client mismatch (server can't know the browser).
  const [micSupported, setMicSupported] = useState<boolean | null>(null);
  useEffect(() => {
    setMicSupported(speechRecognitionSupported());
  }, []);

  const f5Level: Level = f5.available ? "live" : "off";
  const f5Detail = f5.available
    ? `Bartimaeus speaks in his cloned voice via F5-TTS on ${
        f5.device === "cuda" ? "GPU (CUDA)" : "CPU"
      }. Click the 🔊 on any Bartimaeus reply, or use conversation mode.`
    : f5.reason ||
      "F5-TTS not detected — Bartimaeus falls back to the Piper voice.";

  const micLevel: Level = micSupported ? "live" : "off";
  const micDetail =
    micSupported === null
      ? "Checking browser capability…"
      : micSupported
        ? "Click the mic to the left of Send to dictate. Speech is transcribed in-browser via the Web Speech API — no audio leaves this machine to a server, no Whisper download."
        : "This browser has no Web Speech API. Use Chrome or Edge for microphone dictation. The mic button is hidden gracefully meanwhile.";

  const convoDetail = micSupported
    ? 'Toggle the radio icon in the chat toolbar for hands-free "caveman mode": speak → Bartimaeus replies and speaks back → the mic re-arms automatically. Press Escape any time to stop.'
    : "Conversation mode needs the Web Speech API for its microphone loop — unavailable in this browser.";

  return (
    <div className="space-y-2.5" data-testid="voice-status-panel">
      <Row
        icon={<Volume2 size={16} strokeWidth={1.5} />}
        title="F5-TTS · Bartimaeus voice"
        level={f5Level}
        state={f5.available ? "Live" : "Fallback (Piper)"}
        detail={f5Detail}
      />
      <Row
        icon={<Mic size={16} strokeWidth={1.5} />}
        title="Microphone input · Web Speech API"
        level={micLevel}
        state={
          micSupported === null
            ? "Checking…"
            : micSupported
              ? "Available"
              : "Unavailable"
        }
        detail={micDetail}
      />
      <Row
        icon={<Radio size={16} strokeWidth={1.5} />}
        title="Conversation mode · caveman mode"
        level={micLevel}
        state={micSupported ? "Available" : "Unavailable"}
        detail={convoDetail}
      />
    </div>
  );
}
