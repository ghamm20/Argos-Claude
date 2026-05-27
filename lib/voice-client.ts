// lib/voice-client.ts
//
// Phase 5 — browser-side voice helpers.
//
// Two responsibilities:
//   1. Record from the user's microphone via MediaRecorder, decode
//      the captured webm/opus via AudioContext, downsample to 16kHz
//      mono, and encode as a WAV the server-side whisper.cpp can
//      consume directly. NO ffmpeg / native dep required.
//
//   2. Wrap fetch('/api/voice/tts') so the caller gets a playable
//      audio Blob without dealing with the byte plumbing.
//
// The recorder is a tiny class — start(), stop(). stop() returns the
// WAV Buffer ready to POST.
//
// All audio APIs are browser-only (window, MediaRecorder, AudioContext).
// This module is imported only from "use client" components.

export interface RecorderHandle {
  stop: () => Promise<ArrayBuffer>;
  cancel: () => void;
}

export interface StartRecorderOptions {
  /** When set, request capture from this exact deviceId. Chrome will
   *  reject with `OverconstrainedError` if the id no longer exists
   *  (e.g. unplugged webcam). Caller surfaces that as a UI error and
   *  re-enumerates. */
  deviceId?: string;
}

/**
 * Enumerate audio input devices. Returns `[]` if the API is unavailable
 * or permission has never been granted. Note: `label` is empty for any
 * device the page hasn't yet been granted mic permission for — Chrome
 * populates it after the first successful getUserMedia call.
 *
 * Common pattern: enumerate on mount (labels may be blank), then
 * re-enumerate after each record (labels populated).
 */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (typeof window === "undefined") return [];
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

/**
 * Start microphone capture. Returns a handle whose `stop()` resolves
 * with a 16 kHz mono 16-bit PCM WAV (ready to POST to /api/voice/stt).
 *
 * Voice UX (2026-05-27): switched constraints per operator directive:
 *   - echoCancellation/noiseSuppression/autoGainControl now FALSE.
 *     Browser-side AGC compresses dynamic range and can mask quiet
 *     speech onsets that Whisper would otherwise catch; noise
 *     suppression mangles fricatives. On a clean dedicated mic
 *     (C922) raw audio outperforms the browser's processed pipeline.
 *   - `channelCount: 1` and `sampleRate: 16000` requested directly
 *     so the browser doesn't waste cycles delivering stereo 48 kHz
 *     for our subsequent downmix-and-resample step. (Browsers honor
 *     these as preferences; if hardware can't comply we still
 *     re-encode client-side via convertToWav16k.)
 *   - Optional `deviceId` constraint when the operator has picked
 *     a specific input via the MicButton's device selector.
 */
export async function startVoiceRecorder(
  opts: StartRecorderOptions = {}
): Promise<RecorderHandle> {
  if (typeof window === "undefined") {
    throw new Error("startVoiceRecorder is browser-only");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia not available in this browser");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder not available in this browser");
  }

  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 16000,
  };
  if (opts.deviceId) {
    // `exact` so Chrome rejects rather than silently falling back to
    // a different mic when the chosen device is unplugged. Caller
    // catches OverconstrainedError and re-prompts.
    audioConstraints.deviceId = { exact: opts.deviceId };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
  });

  // Prefer mimeTypes whisper-side pipeline can decode reliably.
  // We re-decode client-side anyway, so this is just for MediaRecorder
  // compatibility — let the browser pick.
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  recorder.start(250); // 250ms timeslice = smoother stop transition

  let stopped = false;
  function stopTracks() {
    stream.getTracks().forEach((t) => t.stop());
  }

  return {
    stop: () =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        if (stopped) {
          reject(new Error("recorder already stopped"));
          return;
        }
        stopped = true;
        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, {
              type: recorder.mimeType || "audio/webm",
            });
            const arrayBuf = await blob.arrayBuffer();
            const wav = await convertToWav16k(arrayBuf);
            resolve(wav);
          } catch (e) {
            reject(e);
          } finally {
            stopTracks();
          }
        };
        try {
          recorder.stop();
        } catch (e) {
          stopTracks();
          reject(e);
        }
      }),
    cancel: () => {
      stopped = true;
      try {
        recorder.stop();
      } catch {
        /* ignore — best effort */
      }
      stopTracks();
    },
  };
}

/**
 * Convert any browser-decodable audio buffer to 16 kHz mono 16-bit
 * PCM WAV (the format whisper.cpp wants). Uses OfflineAudioContext
 * for the resample — works in every modern browser; no AudioWorklet
 * boilerplate required.
 */
export async function convertToWav16k(input: ArrayBuffer): Promise<ArrayBuffer> {
  const TARGET_RATE = 16000;
  // AudioContext for the initial decode — must match the source
  // sample rate. Safari/older Chrome require the closure pattern.
  const ctxClass: typeof AudioContext =
    window.AudioContext ||
    // Safari / older fallback. Cast through unknown for strict TS.
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  if (!ctxClass) throw new Error("AudioContext not available");
  const decodeCtx = new ctxClass();
  let buffer: AudioBuffer;
  try {
    buffer = await decodeCtx.decodeAudioData(input.slice(0));
  } finally {
    void decodeCtx.close().catch(() => {});
  }

  // Downmix to mono first if needed.
  const monoLength = buffer.length;
  const mono = new Float32Array(monoLength);
  if (buffer.numberOfChannels === 1) {
    mono.set(buffer.getChannelData(0));
  } else {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.getChannelData(1);
    for (let i = 0; i < monoLength; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
  }

  // Resample via OfflineAudioContext. Compute the output length from
  // the resample ratio.
  const outLength = Math.ceil((mono.length * TARGET_RATE) / buffer.sampleRate);
  const offline = new OfflineAudioContext(1, outLength, TARGET_RATE);
  // Materialize the mono channel as a single-channel buffer at the
  // source rate, then play through the offline context (which
  // resamples on read).
  const monoBuf = offline.createBuffer(1, mono.length, buffer.sampleRate);
  monoBuf.getChannelData(0).set(mono);
  const src = offline.createBufferSource();
  src.buffer = monoBuf;
  src.connect(offline.destination);
  src.start(0);
  const resampled = await offline.startRendering();

  // resampled is a single-channel AudioBuffer at 16 kHz; encode as
  // 16-bit PCM WAV.
  return encodeWavMono16(resampled.getChannelData(0), TARGET_RATE);
}

/** Pack a Float32 mono channel into a 16-bit PCM WAV ArrayBuffer. */
function encodeWavMono16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  // RIFF header
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  // fmt sub-chunk
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  // data sub-chunk
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Float -> int16, clamped.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buf;
}

function writeStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

// ----- TTS client helpers -------------------------------------

/**
 * POST text to /api/voice/tts and resolve with a Blob the caller
 * can hand to HTMLAudioElement.src via URL.createObjectURL.
 * Throws with the server's error message on 4xx/5xx.
 */
export async function synthesizeToBlob(
  text: string,
  opts: { voice?: string; speed?: number; sessionId?: string; personaId?: string; signal?: AbortSignal } = {}
): Promise<Blob> {
  const res = await fetch("/api/voice/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      voice: opts.voice,
      speed: opts.speed,
      sessionId: opts.sessionId,
      // Phase 7: send personaId so the route can pick the persona's voiceId
      personaId: opts.personaId,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let msg = `TTS failed: HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; hint?: string };
      if (j.error) msg = j.error;
      if (j.hint) msg += ` — ${j.hint}`;
    } catch {
      /* ignore — keep generic message */
    }
    throw new Error(msg);
  }
  return await res.blob();
}

/** POST recorded WAV to /api/voice/stt. Returns the transcribed text. */
export async function transcribeBlob(
  wav: ArrayBuffer,
  opts: { language?: string; sessionId?: string; signal?: AbortSignal } = {}
): Promise<string> {
  const params = new URLSearchParams();
  if (opts.language) params.set("lang", opts.language);
  if (opts.sessionId) params.set("sessionId", opts.sessionId);
  const qs = params.toString();
  const url = qs ? `/api/voice/stt?${qs}` : "/api/voice/stt";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
    signal: opts.signal,
  });
  if (!res.ok) {
    let msg = `STT failed: HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; hint?: string };
      if (j.error) msg = j.error;
      if (j.hint) msg += ` — ${j.hint}`;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").trim();
}
