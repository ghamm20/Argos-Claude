// lib/voice-tap.ts
//
// BartAvatar build (2026-06-10) — shared voice-activity tap.
//
// ARGOS TTS playback is Web Audio BufferSource on two module-scope
// AudioContexts (PlayButton.tsx and voice-speech.ts speakText). There is
// no HTMLAudioElement in the live paths, so amplitude-reactive UI can't
// hang an analyser off an element. Instead, both playback sites route
// their source through tapDestination(ctx) — an AnalyserNode connected
// to ctx.destination — and announce start/stop via notifyVoicePlay /
// notifyVoiceEnded. Consumers (BartAvatar) read the live level with
// getVoiceLevel() and subscribe to activity with useVoiceActivity().
//
// Engine-agnostic by construction: ElevenLabs vs F5 vs Piper is decided
// server-side in /api/voice/tts; every engine's bytes flow through the
// same browser graph, so the tap sees them all.
//
// Inserting the analyser does NOT alter audibility or sink routing —
// AnalyserNode passes audio through unchanged, and setSinkId lives on
// the AudioContext, not on any node in the graph.

"use client";

import { useEffect, useState } from "react";

export const VOICE_PLAY_EVENT = "argos:voice-play";
export const VOICE_ENDED_EVENT = "argos:voice-ended";

// One analyser per AudioContext (PlayButton and voice-speech each own a
// context). WeakMap so a closed context can be collected.
const analysers = new WeakMap<AudioContext, AnalyserNode>();

// The analyser feeding the CURRENT playback — getVoiceLevel() reads this.
let activeAnalyser: AnalyserNode | null = null;
let playing = false;
let levelBuf: Uint8Array | null = null;

/**
 * Return the analyser tap for `ctx`, creating and wiring it to
 * ctx.destination on first use. Playback sites connect their
 * BufferSource here INSTEAD of ctx.destination — audio still reaches
 * the speakers via the analyser's passthrough.
 */
export function tapDestination(ctx: AudioContext): AudioNode {
  let a = analysers.get(ctx);
  if (!a) {
    a = ctx.createAnalyser();
    a.fftSize = 256; // 128 bins — plenty for an amplitude envelope
    a.smoothingTimeConstant = 0.5;
    a.connect(ctx.destination);
    analysers.set(ctx, a);
  }
  return a;
}

/** Announce that playback on `ctx` just started. */
export function notifyVoicePlay(ctx: AudioContext): void {
  const a = analysers.get(ctx);
  if (a) activeAnalyser = a;
  playing = true;
  // eslint-disable-next-line no-console
  console.info("[voice-tap] play");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VOICE_PLAY_EVENT));
  }
}

/** Announce that playback ended (natural finish, stop, or pre-emption). */
export function notifyVoiceEnded(): void {
  if (!playing) return; // idempotent — pre-emption can double-fire
  playing = false;
  // eslint-disable-next-line no-console
  console.info("[voice-tap] ended");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VOICE_ENDED_EVENT));
  }
}

export function isVoicePlaying(): boolean {
  return playing;
}

/**
 * Instantaneous voice level 0..1 — average of getByteFrequencyData on
 * the active analyser, normalized. Returns 0 when nothing is playing.
 * Callers do their own temporal smoothing (BartAvatar smooths per-frame).
 */
export function getVoiceLevel(): number {
  if (!playing || !activeAnalyser) return 0;
  const bins = activeAnalyser.frequencyBinCount;
  if (!levelBuf || levelBuf.length !== bins) levelBuf = new Uint8Array(bins);
  activeAnalyser.getByteFrequencyData(levelBuf);
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += levelBuf[i];
  // 0..255 average → 0..1, with a mild boost since speech rarely
  // saturates the full spectrum average.
  return Math.min(1, (sum / bins / 255) * 1.8);
}

// ---------- HTMLAudioElement fallback ----------
//
// No live ARGOS path plays through an HTMLAudioElement today, but
// BartAvatar accepts an audioEl prop for future paths (and the settings
// voice-preview uses `new Audio`). createMediaElementSource can bind
// only ONCE per element for the life of the page, so the binding is
// cached in a WeakMap keyed by element.

let mediaCtx: AudioContext | null = null;
const mediaAnalysers = new WeakMap<HTMLAudioElement, AnalyserNode>();

/**
 * Attach (or return the cached) analyser for an HTMLAudioElement.
 * Routes element → analyser → destination so playback stays audible.
 * Returns null if Web Audio is unavailable.
 */
export function attachMediaElementTap(el: HTMLAudioElement): AnalyserNode | null {
  const cached = mediaAnalysers.get(el);
  if (cached) return cached;
  try {
    if (!mediaCtx || mediaCtx.state === "closed") {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      mediaCtx = new Ctor();
    }
    const src = mediaCtx.createMediaElementSource(el);
    const a = mediaCtx.createAnalyser();
    a.fftSize = 256;
    a.smoothingTimeConstant = 0.5;
    src.connect(a);
    a.connect(mediaCtx.destination);
    mediaAnalysers.set(el, a);
    return a;
  } catch {
    // Element already bound to another context, or autoplay-policy
    // weirdness — caller falls back to the synthetic envelope.
    return null;
  }
}

/** Read a 0..1 level from a specific analyser (audioEl fallback path). */
export function readAnalyserLevel(a: AnalyserNode): number {
  const bins = a.frequencyBinCount;
  const buf = new Uint8Array(bins);
  a.getByteFrequencyData(buf);
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += buf[i];
  return Math.min(1, (sum / bins / 255) * 1.8);
}

/**
 * React hook: true while any ARGOS TTS playback (PlayButton or
 * conversation-mode speakText) is active. Drives BartAvatar's `talking`.
 */
export function useVoiceActivity(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(isVoicePlaying());
    const on = () => setActive(true);
    const off = () => setActive(false);
    window.addEventListener(VOICE_PLAY_EVENT, on);
    window.addEventListener(VOICE_ENDED_EVENT, off);
    return () => {
      window.removeEventListener(VOICE_PLAY_EVENT, on);
      window.removeEventListener(VOICE_ENDED_EVENT, off);
    };
  }, []);
  return active;
}
