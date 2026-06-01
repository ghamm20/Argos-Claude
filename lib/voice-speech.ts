// lib/voice-speech.ts
//
// Phase 7-D — browser voice I/O for the chat UI:
//   1. Web Speech API STT (window.SpeechRecognition) — no Whisper, no deps.
//      createSpeechRecognizer() wraps a single recognition instance with a
//      2-second silence auto-stop and a clean final-transcript callback.
//   2. Programmatic TTS playback — speakText() synthesizes via /api/voice/tts
//      (F5 for Bartimaeus) and plays it on a shared, gesture-unlocked
//      AudioContext so conversation mode can speak without a fresh click.
//
// Browser-only (window/AudioContext/SpeechRecognition); import from
// "use client" components only.

import { synthesizeToBlob, getPersistedSpeakerId } from "./voice-client";

// ---------- Web Speech API (STT) ----------

// Minimal structural types — lib.dom doesn't ship SpeechRecognition types
// everywhere, and we only touch a small surface.
interface SRResultItem { transcript: string }
interface SRResult { isFinal: boolean; 0: SRResultItem }
interface SREvent { resultIndex: number; results: { length: number } & Record<number, SRResult> }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SRCtor = new () => SpeechRecognitionLike;

function getSRCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** True if the browser exposes the Web Speech API (Chrome/Edge). */
export function speechRecognitionSupported(): boolean {
  return !!getSRCtor();
}

export interface Recognizer {
  start: () => void;
  stop: () => void;
  isListening: () => boolean;
}

/**
 * Create a speech recognizer. Accumulates final transcripts; auto-stops after
 * `silenceMs` of no new results (default 2000ms). Calls onFinal(text) once when
 * it stops (only if non-empty). onListeningChange reflects active state.
 */
export function createSpeechRecognizer(opts: {
  onFinal: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
  lang?: string;
  silenceMs?: number;
}): Recognizer {
  const Ctor = getSRCtor();
  let rec: SpeechRecognitionLike | null = null;
  let listening = false;
  let finalText = "";
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const silenceMs = opts.silenceMs ?? 2000;

  function clearSilence() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }
  function armSilence() {
    clearSilence();
    silenceTimer = setTimeout(() => {
      try {
        rec?.stop();
      } catch {
        /* ignore */
      }
    }, silenceMs);
  }

  function setListening(v: boolean) {
    if (listening !== v) {
      listening = v;
      opts.onListeningChange?.(v);
    }
  }

  function start() {
    if (!Ctor || listening) return;
    finalText = "";
    rec = new Ctor();
    rec.lang = opts.lang ?? "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: SREvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r && r.isFinal) {
          finalText += (finalText ? " " : "") + r[0].transcript.trim();
        }
      }
      armSilence(); // any speech resets the 2s silence countdown
    };
    rec.onerror = () => {
      /* no-result / aborted — handled by onend */
    };
    rec.onend = () => {
      clearSilence();
      setListening(false);
      const t = finalText.trim();
      if (t) opts.onFinal(t);
    };
    try {
      rec.start();
      setListening(true);
      armSilence();
    } catch {
      setListening(false);
    }
  }

  function stop() {
    clearSilence();
    try {
      rec?.stop();
    } catch {
      /* ignore */
    }
  }

  return { start, stop, isListening: () => listening };
}

// ---------- Programmatic TTS playback ----------

let sharedCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

function getCtx(): AudioContext {
  if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
  const Ctor: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  sharedCtx = new Ctor();
  return sharedCtx;
}

/** Unlock/resume the shared AudioContext. MUST be called from a user gesture
 *  (e.g. the conversation-toggle click) so later programmatic speakText()
 *  calls aren't blocked by the browser autoplay policy. */
export function unlockAudioContext(): void {
  try {
    const ctx = getCtx();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Stop any in-progress programmatic playback. */
export function stopSpeaking(): void {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    currentSource = null;
  }
}

type CtxWithSink = AudioContext & { setSinkId: (id: string) => Promise<void> };

/**
 * Synthesize `text` (F5 for Bartimaeus, else Piper) and play it on the shared
 * context. Resolves when playback finishes (or is aborted). Pre-empts any
 * current playback. Honors the operator's selected output device.
 */
export async function speakText(
  text: string,
  opts: { personaId?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const blob = await synthesizeToBlob(text, {
    personaId: opts.personaId,
    signal: opts.signal,
  });
  if (opts.signal?.aborted) return;
  const arrayBuf = await blob.arrayBuffer();
  const ctx = getCtx();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
  if (opts.signal?.aborted) return;

  // Route to the operator-selected sink when supported.
  const sink = getPersistedSpeakerId();
  if (sink) {
    const c = ctx as Partial<CtxWithSink>;
    if (typeof c.setSinkId === "function") {
      await (c as CtxWithSink).setSinkId(sink).catch(() => {});
    }
  }

  stopSpeaking();
  return new Promise<void>((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      resolve();
    };
    currentSource = src;
    const onAbort = () => {
      try {
        src.stop();
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    src.start(0);
  });
}
