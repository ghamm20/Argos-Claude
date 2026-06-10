// lib/voice.ts
//
// Phase 5 — voice I/O orchestration (Whisper STT + Kokoro TTS).
//
// USB-native scaffold: binaries + models live under
// $ARGOS_ROOT/tools/voice/. The server never bundles them — the
// operator drops them in following docs/VOICE.md. This module:
//
//   * Resolves binary + model paths from ARGOS_ROOT (Rule #1 + #5)
//   * Detects capability at request time (cheap; sub-millisecond stat)
//   * Spawns child processes and pipes audio in/out of stdin/stdout
//     where the binary supports it; falls back to disk-temp files
//     for binaries that only accept --in/--out paths.
//   * Never blocks the chat path: if a binary is missing, the route
//     returns 503 with a clear "install voice" hint and the audit
//     chain logs nothing (no event happened).
//
// Cross-platform: Windows ships .exe, mac/linux ships an unsuffixed
// binary. resolveBinary() probes both.
//
// Concurrency: voice ops are bursty but short-lived (1-15s each).
// We don't pool or queue — Node's fork/exec model handles serial
// invocations fine at single-operator scale. If voice ever becomes
// a bottleneck (e.g. an agent batch-transcribing 100 clips) we'd
// add a tiny in-process job queue; out of v1.0 scope.

import { promises as fsp, existsSync } from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { argosRoot } from "./vault/paths";
// Phase 7-C — ElevenLabs config (key decrypted at use; never logged).
import { readSettings } from "./settings";
import { decryptSecret } from "./web/secrets";

// ----- paths -----------------------------------------------------

/** Root of the voice tool tree. Always under ARGOS_ROOT. */
export function voiceToolsDir(): string {
  return path.join(argosRoot(), "tools", "voice");
}

/** Whisper subtree. Operator places binary + model here. */
export function whisperDir(): string {
  return path.join(voiceToolsDir(), "whisper");
}

/** Kokoro subtree. Operator places binary + model + voices here. */
export function kokoroDir(): string {
  return path.join(voiceToolsDir(), "kokoro");
}

/**
 * Phase 7-B (2026-05-26) — Piper subtree. Active TTS engine (Kokoros
 * binary doesn't exist as a public release; Piper has real Windows
 * binaries + a per-voice ONNX model file format).
 *
 * Layout:
 *   tools/voice/piper/piper.exe         ← binary
 *   tools/voice/piper/*.dll             ← runtime DLLs from the zip
 *   tools/voice/piper/espeak-ng-data/   ← phonemizer language data
 *   tools/voice/piper/voices/<id>.onnx  ← voice model
 *   tools/voice/piper/voices/<id>.onnx.json  ← per-voice config
 */
export function piperDir(): string {
  return path.join(voiceToolsDir(), "piper");
}

export function piperVoicesDir(): string {
  return path.join(piperDir(), "voices");
}

/** Scratch dir for short-lived wav/text files during a single op. */
export function voiceCacheDir(): string {
  return path.join(argosRoot(), "state", "voice", "cache");
}

// ----- binary resolution ----------------------------------------

const IS_WINDOWS = process.platform === "win32";

/**
 * Probe for a binary inside a directory. Tries the .exe form on
 * Windows first, then the bare name. Returns the absolute path
 * if it exists and is a regular file, otherwise null.
 *
 * The operator's install README documents the expected names
 * (whisper-cli.exe / whisper-cli / kokoro.exe / kokoro). Multiple
 * candidates accommodate both whisper.cpp's `whisper-cli` and the
 * older `main`/`whisper` names.
 */
function probeBinary(dir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const withExe = IS_WINDOWS && !name.endsWith(".exe") ? `${name}.exe` : name;
    const full = path.join(dir, withExe);
    if (existsSync(full)) return full;
    // Also accept the bare name on Windows (e.g. some users symlink)
    if (IS_WINDOWS) {
      const bare = path.join(dir, name);
      if (existsSync(bare)) return bare;
    }
  }
  return null;
}

const WHISPER_CANDIDATES = ["whisper-cli", "whisper", "main"];
const KOKORO_CANDIDATES = ["kokoros", "kokoro", "kokoro-tts"];

/** Resolve the whisper binary path (.exe-suffixed on Windows). */
export function whisperBinary(): string | null {
  return probeBinary(whisperDir(), WHISPER_CANDIDATES);
}

/** Resolve the kokoro binary path. */
export function kokoroBinary(): string | null {
  return probeBinary(kokoroDir(), KOKORO_CANDIDATES);
}

const PIPER_CANDIDATES = ["piper"];

/** Resolve the Piper binary path. Phase 7-B preferred TTS engine. */
export function piperBinary(): string | null {
  return probeBinary(piperDir(), PIPER_CANDIDATES);
}

/**
 * Resolve a Piper voice model path by voiceId. The persona's `voiceId`
 * field (e.g. "en_US-ryan-high") becomes filename:
 *   tools/voice/piper/voices/en_US-ryan-high.onnx
 *
 * Returns null if the file doesn't exist — caller short-circuits with
 * a capability error.
 */
export function piperVoiceModel(voiceId: string): string | null {
  const full = path.join(piperVoicesDir(), `${voiceId}.onnx`);
  return existsSync(full) ? full : null;
}

/**
 * Returns true if AT LEAST ONE `.onnx` voice exists in the Piper voices
 * dir. Used by capability detection — having the binary but no voices
 * means TTS isn't usable.
 */
export async function piperHasAnyVoice(): Promise<boolean> {
  try {
    const entries = await fsp.readdir(piperVoicesDir());
    return entries.some((e) => e.endsWith(".onnx"));
  } catch {
    return false;
  }
}

// ----- model resolution -----------------------------------------

/**
 * Pick the first `.bin` file under tools/voice/whisper/models/.
 * Whisper.cpp's GGML models are *.bin (e.g. ggml-base.en.bin).
 * Stable fallback to a documented default name if the dir is empty.
 *
 * Returns null if no model file is found — the API routes use this
 * to short-circuit with a clear capability error.
 */
export async function whisperModel(): Promise<string | null> {
  const dir = path.join(whisperDir(), "models");
  try {
    const entries = await fsp.readdir(dir);
    const bins = entries.filter((e) => e.endsWith(".bin")).sort();
    if (bins.length === 0) return null;
    // Prefer ggml-base.en.bin if present (good default English balance).
    const preferred = bins.find((b) => b === "ggml-base.en.bin");
    return path.join(dir, preferred ?? bins[0]);
  } catch {
    return null;
  }
}

/**
 * Pick the first `.onnx` file under tools/voice/kokoro/. Phase 7 (2026-05-25):
 * searches BOTH the top-level `tools/voice/kokoro/` AND the `models/` subdir
 * for back-compat. Operators following the directive's exact paths get
 * top-level files; operators following the original Phase 5 docs get
 * `models/` files. Both work.
 *
 * Preference order if multiple `.onnx` files exist:
 *   1. `kokoro-v1.0.fp16.onnx` (smaller + faster on CPU)
 *   2. `kokoro-v1.0.onnx` (full fp32)
 *   3. first alphabetically
 */
export async function kokoroModel(): Promise<string | null> {
  for (const dir of [kokoroDir(), path.join(kokoroDir(), "models")]) {
    try {
      const entries = await fsp.readdir(dir);
      const onnxs = entries.filter((e) => e.endsWith(".onnx")).sort();
      if (onnxs.length === 0) continue;
      const preferred =
        onnxs.find((o) => o === "kokoro-v1.0.fp16.onnx") ??
        onnxs.find((o) => o === "kokoro-v1.0.onnx") ??
        onnxs[0];
      return path.join(dir, preferred);
    } catch {
      /* not present; try next dir */
    }
  }
  return null;
}

/**
 * Pick the voices bin/json file. Searches BOTH top-level and `models/`
 * subdir (Phase 7 directive expected top-level; Phase 5 scaffold used
 * `models/`). Accepts: voices*.bin, voices*.json, voices-v1.0.bin etc.
 */
export async function kokoroVoices(): Promise<string | null> {
  for (const dir of [kokoroDir(), path.join(kokoroDir(), "models")]) {
    try {
      const entries = await fsp.readdir(dir);
      const voices = entries.find((e) => /^voices.*\.(bin|json)$/i.test(e));
      if (voices) return path.join(dir, voices);
    } catch {
      /* not present; try next dir */
    }
  }
  return null;
}

// ----- capability snapshot --------------------------------------

export interface VoiceCapability {
  /** STT (Whisper) status snapshot. */
  stt: {
    available: boolean;
    binary: string | null;
    model: string | null;
    reason: string | null; // human-friendly explanation if !available
  };
  /** TTS status snapshot. Phase 7-B: dual-engine (Piper preferred,
   *  Kokoro retained as option if a binary ever lands). `engine`
   *  reports which one will actually serve requests. */
  tts: {
    available: boolean;
    engine: "piper" | "kokoro" | null;
    binary: string | null;
    /** Engine-specific notes:
     *  - Piper: this is the voices DIR (per-voice .onnx files inside)
     *  - Kokoro: this is the single ONNX model path
     */
    model: string | null;
    /** Engine-specific notes:
     *  - Piper: null (each voice IS the model file)
     *  - Kokoro: voices-v1.0.bin path
     */
    voices: string | null;
    reason: string | null;
  };
  /** Filled by the status route; constant per request. */
  argosRoot: string;
  toolsDir: string;
}

/**
 * Cheap detection — no process spawn, only stat calls. Safe to call
 * on every UI mount + every refresh. Always-fresh; never cached.
 */
export async function detectVoiceCapability(): Promise<VoiceCapability> {
  const sttBin = whisperBinary();
  const sttModel = await whisperModel();

  // Phase 7-B: TTS prefers Piper. Fall back to Kokoro only if Piper
  // isn't installed AND a Kokoro binary lives in the kokoro/ dir
  // (which is unusual since kokoros.exe isn't a real release — but
  // the optionality stays in case operator builds from source).
  const piperBin = piperBinary();
  const piperHasVoice = await piperHasAnyVoice();
  const kokoroBin = kokoroBinary();
  const kokoroModelFile = await kokoroModel();
  const kokoroVoicesFile = await kokoroVoices();

  function sttReason(): string | null {
    if (sttBin && sttModel) return null;
    if (!sttBin && !sttModel)
      return `whisper binary + model missing. See tools/voice/README.md.`;
    if (!sttBin)
      return `whisper binary missing in ${whisperDir()}. Drop whisper-cli(.exe) there.`;
    return `whisper model missing in ${path.join(whisperDir(), "models")}. Drop a ggml-*.bin there.`;
  }

  // Engine selection — Piper wins if both binary + at least one voice
  // are present. Else Kokoro IFF its full triplet is present. Else
  // null (unavailable, with a Piper-flavored reason since Piper is
  // the recommended path).
  let engine: "piper" | "kokoro" | null = null;
  let ttsAvailable = false;
  let ttsBinaryOut: string | null = null;
  let ttsModelOut: string | null = null;
  let ttsVoicesOut: string | null = null;
  let ttsReasonOut: string | null = null;

  if (piperBin && piperHasVoice) {
    engine = "piper";
    ttsAvailable = true;
    ttsBinaryOut = piperBin;
    ttsModelOut = piperVoicesDir(); // dir of per-voice .onnx
    ttsVoicesOut = null;
  } else if (kokoroBin && kokoroModelFile && kokoroVoicesFile) {
    engine = "kokoro";
    ttsAvailable = true;
    ttsBinaryOut = kokoroBin;
    ttsModelOut = kokoroModelFile;
    ttsVoicesOut = kokoroVoicesFile;
  } else {
    // Unavailable — surface the Piper-side reason (recommended path).
    // If operator wants Kokoro instead, the docs cover it; this just
    // tells them the fastest fix.
    if (!piperBin) {
      ttsReasonOut = `piper binary missing in ${piperDir()}. Drop piper.exe + DLLs there (see docs/VOICE.md).`;
    } else {
      ttsReasonOut = `piper has no voices: drop a .onnx (+ .onnx.json) into ${piperVoicesDir()}.`;
    }
  }

  return {
    stt: {
      available: !!(sttBin && sttModel),
      binary: sttBin,
      model: sttModel,
      reason: sttReason(),
    },
    tts: {
      available: ttsAvailable,
      engine,
      binary: ttsBinaryOut,
      model: ttsModelOut,
      voices: ttsVoicesOut,
      reason: ttsReasonOut,
    },
    argosRoot: argosRoot(),
    toolsDir: voiceToolsDir(),
  };
}

// ----- spawn helpers --------------------------------------------

export interface SpawnResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  durationMs: number;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 60_000;

/**
 * Spawn a child process, collect stdout (binary) + stderr (text),
 * enforce a hard timeout. Used for both whisper and kokoro invocations.
 *
 * Defensive timeout: voice ops should be sub-15s on modest hardware;
 * 60s default catches a stuck binary without giving up too early.
 * Caller can override via opts.timeoutMs.
 */
export function spawnVoice(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; spawnOptions?: SpawnOptions } = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...opts.spawnOptions,
    });

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out: SpawnResult = {
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderr.trim(),
        durationMs: Date.now() - start,
      };
      if (timedOut) {
        reject(
          new Error(
            `voice binary timed out after ${opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS}ms (${path.basename(bin)})`
          )
        );
        return;
      }
      resolve(out);
    });
  });
}

// ----- whisper invocation ---------------------------------------

export interface TranscribeResult {
  text: string;
  durationMs: number;
  modelBasename: string;
  audioBytes: number;
}

/**
 * Minimum audio duration (seconds) we feed to whisper-cli. Anything
 * shorter (after silence trim) gets zero-padded up to this floor.
 *
 * Why: whisper.cpp's small.en model reliably hallucinates on very
 * short clips — a 400ms "hello" comes back as "you", a 600ms "stop"
 * comes back as phantom sentences. The model needs enough context
 * to anchor against real speech; below the threshold its prior takes
 * over and it confabulates. Padding with PCM silence (zero bytes)
 * gives the encoder dead air to chew on without changing the transcript.
 *
 * Bumped from 1.5 → 2.5 (2026-05-27 Voice UX): operator still saw
 * occasional "you" hallucinations on borderline 1.6-1.9s clips after
 * the earlier fix. 2.5s puts the whole comfortable speech window
 * inside the model's reliable zone with overhead to spare. Cost: ~1s
 * of additional silent tail processed by whisper-cli, which on
 * small.en is ~50 ms of extra compute. Worth it.
 */
const MIN_STT_SECONDS = 2.5;

/**
 * Default silence threshold for trimWavSilence. 500 out of 32768
 * (full-scale for signed 16-bit PCM) ≈ 1.5% of max amplitude. Low
 * enough to count breath/room-tone as silence but high enough that
 * real speech crosses it on every onset.
 */
const SILENCE_THRESHOLD = 500;

/**
 * Guard duration kept on either side of detected speech. Without this
 * the trim can clip off a consonant's leading edge (e.g. the air-burst
 * of a /p/ or /t/). 100 ms is comfortably below the perceptual
 * threshold for "missing sound" and well above MediaRecorder's typical
 * chunk size.
 */
const SILENCE_GUARD_MS = 100;

/**
 * Internal: parse the RIFF/WAVE header into a small struct. Returns
 * null if anything is off (we then bail out of trim/pad gracefully).
 *
 * Shared by trimWavSilence + padWavToMinDuration so the data-chunk
 * scan only lives in one place.
 */
interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  dataChunkOffset: number; // offset of the "data" marker
  dataStart: number;       // offset of the first audio byte
  dataSize: number;        // size of the audio payload in bytes
}

function parseWavHeader(wav: Buffer): WavInfo | null {
  if (wav.length < 44) return null;
  if (wav.slice(0, 4).toString("ascii") !== "RIFF") return null;
  if (wav.slice(8, 12).toString("ascii") !== "WAVE") return null;
  const audioFormat = wav.readUInt16LE(20);
  if (audioFormat !== 1) return null; // PCM only
  const numChannels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const byteRate = wav.readUInt32LE(28);
  const blockAlign = wav.readUInt16LE(32);
  const bitsPerSample = wav.readUInt16LE(34);
  if (!byteRate || !sampleRate || !numChannels || !bitsPerSample) return null;

  // Find the "data" subchunk marker (0x64 0x61 0x74 0x61 = "data").
  let dataChunkOffset = -1;
  for (let i = 12; i <= wav.length - 8; i++) {
    if (
      wav[i] === 0x64 &&
      wav[i + 1] === 0x61 &&
      wav[i + 2] === 0x74 &&
      wav[i + 3] === 0x61
    ) {
      dataChunkOffset = i;
      break;
    }
  }
  if (dataChunkOffset < 0) return null;
  const dataSize = wav.readUInt32LE(dataChunkOffset + 4);
  const dataStart = dataChunkOffset + 8;
  if (dataStart + dataSize > wav.length) return null;
  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    byteRate,
    blockAlign,
    dataChunkOffset,
    dataStart,
    dataSize,
  };
}

/**
 * Trim leading + trailing silence from a 16-bit mono PCM WAV. Silence
 * is defined as samples where |value| < SILENCE_THRESHOLD. We keep
 * SILENCE_GUARD_MS of audio on each side of the detected speech so
 * consonant onsets aren't clipped.
 *
 * Returns the original buffer unchanged in any of these cases:
 *   - Header parse fails / format isn't 16-bit mono PCM
 *   - Entire payload is silence (whisper still wants something to
 *     consume; padding adds the rest)
 *   - Trim would not actually shorten the file
 *
 * Why trim BEFORE padding: the operator records something like
 *   [400 ms dead air][800 ms speech][600 ms dead air]
 * On a 1.8 s clip we'd previously skip padding (>= 1.5 s). After
 * trim that's 800 ms of speech + 200 ms guard = 1.0 s of real
 * audio, and padding bumps it to 2.5 s with clean silence framing.
 * Whisper anchors on the speech, not on the surrounding hum.
 */
export function trimWavSilence(
  wav: Buffer,
  threshold = SILENCE_THRESHOLD,
  guardMs = SILENCE_GUARD_MS
): Buffer {
  try {
    const info = parseWavHeader(wav);
    if (!info) return wav;
    if (info.bitsPerSample !== 16) return wav;     // only 16-bit PCM
    if (info.numChannels !== 1) return wav;        // only mono
    if (info.dataSize < info.blockAlign * 2) return wav; // too small

    const sampleBytes = 2; // 16-bit mono
    const totalSamples = Math.floor(info.dataSize / sampleBytes);
    const view = new DataView(
      wav.buffer,
      wav.byteOffset + info.dataStart,
      info.dataSize
    );

    // Find first non-silent sample.
    let first = -1;
    for (let i = 0; i < totalSamples; i++) {
      const v = view.getInt16(i * sampleBytes, true);
      if (Math.abs(v) >= threshold) {
        first = i;
        break;
      }
    }
    if (first < 0) return wav; // entire payload is silence

    // Find last non-silent sample.
    let last = totalSamples - 1;
    for (let i = totalSamples - 1; i >= 0; i--) {
      const v = view.getInt16(i * sampleBytes, true);
      if (Math.abs(v) >= threshold) {
        last = i;
        break;
      }
    }

    const guardSamples = Math.floor((info.sampleRate * guardMs) / 1000);
    const trimStart = Math.max(0, first - guardSamples);
    const trimEnd = Math.min(totalSamples - 1, last + guardSamples);

    // Bail if trim wouldn't actually reduce the data (or somehow grew).
    const newSampleCount = trimEnd - trimStart + 1;
    if (newSampleCount >= totalSamples) return wav;

    const newDataSize = newSampleCount * sampleBytes;
    // Rebuild buffer: copy header (up through dataChunkOffset + 8 bytes
    // of "data" + length field), then the trimmed sample region.
    const header = wav.slice(0, info.dataStart);
    const trimmedData = wav.slice(
      info.dataStart + trimStart * sampleBytes,
      info.dataStart + (trimEnd + 1) * sampleBytes
    );
    const out = Buffer.concat([header, trimmedData]);

    // Patch lengths:
    //   RIFF chunk size = (file size) - 8 = out.length - 8
    //   data subchunk size = newDataSize
    out.writeUInt32LE(out.length - 8, 4);
    out.writeUInt32LE(newDataSize, info.dataChunkOffset + 4);

    return out;
  } catch {
    return wav;
  }
}

/**
 * Parse a RIFF/WAVE header, compute duration from byteRate + data
 * chunk size, and zero-pad the audio if it's shorter than
 * `minSeconds`. Returns the original buffer unchanged if it's already
 * long enough OR if header parsing fails (we never break the pipeline
 * — unpadded short clips just risk hallucination, which is the
 * pre-fix baseline).
 *
 * Header layout we care about:
 *   bytes 0-3   "RIFF"
 *   bytes 4-7   RIFF chunk size (LE uint32, = file size - 8)
 *   bytes 8-11  "WAVE"
 *   bytes 28-31 byteRate (= sampleRate * channels * bitsPerSample/8)
 *   bytes ?-?   "data" marker + LE uint32 data size, audio follows
 *
 * We scan for "data" instead of assuming offset 36 because some
 * WAV producers (incl. some MediaRecorder builds) emit a LIST/INFO
 * chunk between "fmt " and "data".
 */
export function padWavToMinDuration(wav: Buffer, minSeconds: number): Buffer {
  try {
    if (wav.length < 44) return wav;
    if (wav.slice(0, 4).toString("ascii") !== "RIFF") return wav;
    if (wav.slice(8, 12).toString("ascii") !== "WAVE") return wav;
    const byteRate = wav.readUInt32LE(28);
    if (!byteRate) return wav;

    // Find the "data" subchunk marker (0x64 0x61 0x74 0x61).
    let dataChunkOffset = -1;
    for (let i = 12; i <= wav.length - 8; i++) {
      if (
        wav[i] === 0x64 &&
        wav[i + 1] === 0x61 &&
        wav[i + 2] === 0x74 &&
        wav[i + 3] === 0x61
      ) {
        dataChunkOffset = i;
        break;
      }
    }
    if (dataChunkOffset < 0) return wav;

    const dataSize = wav.readUInt32LE(dataChunkOffset + 4);
    const durationSec = dataSize / byteRate;
    if (durationSec >= minSeconds) return wav;

    const targetBytes = Math.ceil(byteRate * minSeconds);
    const padBytes = targetBytes - dataSize;
    if (padBytes <= 0) return wav;

    const silence = Buffer.alloc(padBytes); // zero-init = PCM silence
    const padded = Buffer.concat([wav, silence]);

    // Rewrite the two length fields so the file is still a valid WAV:
    //   RIFF chunk size (bytes 4-7) += padBytes
    //   data subchunk size (bytes dataChunkOffset+4..+7) += padBytes
    padded.writeUInt32LE(padded.readUInt32LE(4) + padBytes, 4);
    padded.writeUInt32LE(dataSize + padBytes, dataChunkOffset + 4);

    return padded;
  } catch {
    // Any parse error → return original. Hallucination risk on a
    // short clip beats a broken transcription pipeline.
    return wav;
  }
}

/**
 * Transcribe a WAV (16kHz mono PCM) buffer using whisper.cpp.
 *
 * Strategy:
 *  - Write the WAV to state/voice/cache/<uuid>.wav
 *  - Invoke whisper-cli with `-m model.bin -f input.wav -otxt -of out`
 *    so it writes to out.txt; we then read that
 *  - Clean up both files in `finally`
 *
 * Why disk + -otxt instead of stdin/stdout: whisper-cli's stdout
 * includes timing headers and per-segment timestamps even with
 * --no-prints. The `-otxt -of` route produces clean transcript-only
 * text we can return verbatim. Cost: two short fs ops per call.
 */
export async function transcribeWav(
  wav: Buffer,
  opts: { language?: string; threads?: number } = {}
): Promise<TranscribeResult> {
  const bin = whisperBinary();
  const model = await whisperModel();
  if (!bin || !model) {
    throw new Error(
      "voice STT not configured: whisper binary or model missing. See tools/voice/README.md"
    );
  }

  // Short-utterance defense — two-step:
  //   1. Trim leading/trailing silence so whisper sees only the real
  //      speech surrounded by a small guard. Stops the model from
  //      anchoring on background hum.
  //   2. Pad the result to MIN_STT_SECONDS of clean silence so the
  //      encoder has a stable framing window. Without enough audio,
  //      small.en hallucinates ("you", "I", phantom sentences).
  // Both are no-ops if the input doesn't need them — e.g. a clip
  // that's already 4 s of pure speech bypasses both.
  const trimmed = trimWavSilence(wav);
  const wavForWhisper = padWavToMinDuration(trimmed, MIN_STT_SECONDS);

  await fsp.mkdir(voiceCacheDir(), { recursive: true });
  const id = randomUUID().replace(/-/g, "");
  const wavPath = path.join(voiceCacheDir(), `${id}.wav`);
  const outBase = path.join(voiceCacheDir(), `${id}-out`); // whisper appends .txt
  const txtPath = `${outBase}.txt`;

  await fsp.writeFile(wavPath, wavForWhisper);

  try {
    const args = [
      "-m",
      model,
      "-f",
      wavPath,
      "-otxt",
      "-of",
      outBase,
      "--no-prints",
      "--no-timestamps",
    ];
    if (opts.language) args.push("-l", opts.language);
    if (opts.threads && opts.threads > 0)
      args.push("-t", String(opts.threads));

    const res = await spawnVoice(bin, args, { timeoutMs: 120_000 });
    if (res.exitCode !== 0) {
      throw new Error(
        `whisper exited ${res.exitCode}: ${res.stderr || "(no stderr)"}`
      );
    }
    let text = "";
    try {
      text = (await fsp.readFile(txtPath, "utf8")).trim();
    } catch {
      // Some whisper-cli builds write to stdout if -of has issues —
      // fall back to that.
      text = res.stdout.toString("utf8").trim();
    }
    return {
      text,
      durationMs: res.durationMs,
      modelBasename: path.basename(model),
      audioBytes: wav.length,
    };
  } finally {
    // Best-effort cleanup. Cache dir survives so an operator can
    // diff failed runs if they care to.
    await Promise.allSettled([fsp.unlink(wavPath), fsp.unlink(txtPath)]);
  }
}

// ----- kokoro invocation ----------------------------------------

export interface SynthesizeResult {
  wav: Buffer;
  durationMs: number;
  voice: string;
  charCount: number;
  /** Phase 7-C — true when ElevenLabs served this synth (Bartimaeus only). */
  elevenlabsUsed?: boolean;
}

// ----- ElevenLabs (Phase 7-C) -----------------------------------
//
// Bartimaeus speaks in his ElevenLabs "Sael" voice when an API key is
// configured (locked to Sael, owner decision 2026-06-10 — the id
// aGv5jHWKBy8K5xKvYeSX was previously mislabeled "Cassius" in comments).
// Network-OPTIONAL: no key (or any failure) → silent fall-through
// to F5/Piper. The key is read+decrypted at call time and NEVER logged.

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
// PCM @ 24 kHz mono 16-bit — wrapped in a WAV header so the response stays
// honest audio/wav and reuses the existing WAV pipeline (no MP3 transcode, no
// new dep). Available on ElevenLabs Starter tier and above; if a tier rejects
// it the call fails → silent Piper fallback (doctrine).
const ELEVENLABS_OUTPUT = "pcm_24000";
const ELEVENLABS_SAMPLE_RATE = 24000;

interface ElevenLabsResolved {
  apiKey: string;
  voiceId: string;
  model: string;
}

/** Read + decrypt the ElevenLabs config. null when no key is set (Bart stays on
 *  Piper, silently — doctrine). Never logs the key. */
async function resolveElevenLabs(): Promise<ElevenLabsResolved | null> {
  try {
    const cfg = (await readSettings()).elevenlabs;
    if (!cfg?.apiKey) return null;
    const apiKey = await decryptSecret(cfg.apiKey);
    if (!apiKey) return null;
    return {
      apiKey,
      voiceId: (cfg.bartVoiceId || "aGv5jHWKBy8K5xKvYeSX").trim(),
      model: (cfg.model || "eleven_multilingual_v2").trim(),
    };
  } catch {
    return null;
  }
}

/** Wrap raw signed-16-bit-LE mono PCM in a 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Synthesize via ElevenLabs (Bartimaeus only). THROWS on any failure so the
 * caller can silently fall back to Piper. The API key is sent only in the
 * xi-api-key header and is never logged — error logs carry the HTTP status +
 * a short response excerpt, not the key.
 */
async function synthesizeElevenLabs(
  text: string,
  cfg: ElevenLabsResolved
): Promise<SynthesizeResult> {
  const url = `${ELEVENLABS_BASE}/${encodeURIComponent(cfg.voiceId)}?output_format=${ELEVENLABS_OUTPUT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": cfg.apiKey,
        "content-type": "application/json",
        accept: "audio/*",
      },
      body: JSON.stringify({
        text,
        model_id: cfg.model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.77,
          style: 0,
          use_speaker_boost: true,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(`ElevenLabs HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const pcm = Buffer.from(await res.arrayBuffer());
    if (pcm.length === 0) throw new Error("ElevenLabs returned empty audio");
    return {
      wav: pcmToWav(pcm, ELEVENLABS_SAMPLE_RATE),
      durationMs: Date.now() - start,
      voice: "bartimaeus-elevenlabs",
      charCount: text.length,
      elevenlabsUsed: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Kokoro fallback voice (only used if engine === "kokoro" — which
// requires a `kokoros.exe` that doesn't exist as a public release).
export const DEFAULT_KOKORO_VOICE = "af_bella";

// Phase 7-B default Piper voice — Bart's voice. Used when the
// /api/voice/tts request omits BOTH voice and personaId.
export const DEFAULT_PIPER_VOICE = "en_US-ryan-high";

/**
 * Synthesize text → WAV. Dispatches to whichever TTS engine is
 * available (Piper preferred per Phase 7-B; Kokoro fallback for
 * when/if its binary lands).
 *
 * Voice resolution:
 *   - If opts.voice is set, use it as-is (engine-specific naming —
 *     Piper expects "en_US-ryan-high", Kokoro expects "af_bella")
 *   - Else fall back to the engine's default
 *
 * The persona's `voiceId` should match the active engine — the
 * /api/voice/tts route resolves persona.voiceId before calling us.
 */
export async function synthesizeText(
  text: string,
  opts: { voice?: string; speed?: number; personaId?: string } = {}
): Promise<SynthesizeResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("voice TTS: empty text");
  }
  // Sanity cap. ~1500 chars ~ 90s of audio at typical pace.
  // Saves the operator from accidentally synthesizing a 50KB blob.
  const TEXT_CAP = 4000;
  if (trimmed.length > TEXT_CAP) {
    throw new Error(
      `voice TTS: text too long (${trimmed.length} chars > ${TEXT_CAP} cap)`
    );
  }

  // Phase 7-C: Bartimaeus's voice chain — ElevenLabs (Sael) → F5 clone →
  // Piper. Each tier is network-/tool-OPTIONAL; ANY failure falls silently to
  // the next so the voice path never breaks (doctrine).
  if (opts.personaId === "bartimaeus") {
    // 1) ElevenLabs — Bart's primary voice WHEN an API key is configured.
    //    No key → resolveElevenLabs() returns null and we fall through quietly
    //    (the common offline case; not a warning). A configured key that fails
    //    (network/API/tier) logs a non-secret warning, then falls through.
    const elCfg = await resolveElevenLabs();
    if (elCfg) {
      try {
        return await synthesizeElevenLabs(trimmed, elCfg);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[voice] ElevenLabs failed for Bartimaeus, falling back to Piper: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }
    // 2) F5 clone — only if present (Dynamic import avoids a circular dep).
    try {
      const { isF5Available, synthesizeF5 } = await import("./voice-f5");
      if (isF5Available()) {
        return await synthesizeF5(trimmed, { speed: opts.speed });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[voice] F5-TTS unavailable/failed for Bartimaeus, falling back to Piper: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  // Engine selection mirrors detectVoiceCapability().
  const piperBin = piperBinary();
  if (piperBin && (await piperHasAnyVoice())) {
    return synthesizePiper(trimmed, opts, piperBin);
  }

  // Kokoro fallback (would only fire if a real kokoros binary exists).
  const kokoroBin = kokoroBinary();
  const kokoroModelFile = await kokoroModel();
  const kokoroVoicesFile = await kokoroVoices();
  if (kokoroBin && kokoroModelFile && kokoroVoicesFile) {
    return synthesizeKokoro(trimmed, opts, kokoroBin, kokoroModelFile, kokoroVoicesFile);
  }

  throw new Error(
    "voice TTS not configured: no TTS engine available. Install Piper per docs/VOICE.md."
  );
}

/**
 * Piper-specific synth path. Spawn shape:
 *   piper.exe --model <voice.onnx> --output_file <out.wav>
 * Text is fed via STDIN (not a CLI arg). Piper writes the WAV to
 * --output_file and prints status to stderr.
 */
async function synthesizePiper(
  text: string,
  opts: { voice?: string; speed?: number },
  bin: string
): Promise<SynthesizeResult> {
  const voiceId = opts.voice || DEFAULT_PIPER_VOICE;
  const modelPath = piperVoiceModel(voiceId);
  if (!modelPath) {
    throw new Error(
      `piper voice "${voiceId}" not installed at ${piperVoicesDir()}/${voiceId}.onnx`
    );
  }
  await fsp.mkdir(voiceCacheDir(), { recursive: true });
  const id = randomUUID().replace(/-/g, "");
  const outPath = path.join(voiceCacheDir(), `${id}.wav`);

  try {
    const start = Date.now();
    const result: SpawnResult = await new Promise((resolve, reject) => {
      const child = spawn(bin, ["--model", modelPath, "--output_file", outPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stderrChunks: Buffer[] = [];
      child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`piper timed out after 60s (voice: ${voiceId})`));
      }, 60_000);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          stdout: Buffer.alloc(0),
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
          durationMs: Date.now() - start,
        });
      });
      // Piper expects text on stdin; close after writing.
      child.stdin.write(text);
      child.stdin.end();
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `piper exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`
      );
    }
    const wav = await fsp.readFile(outPath);
    return {
      wav,
      durationMs: result.durationMs,
      voice: voiceId,
      charCount: text.length,
    };
  } finally {
    await fsp.unlink(outPath).catch(() => {});
  }
}

/**
 * Kokoro fallback path. Only reachable if Piper is unavailable AND a
 * Kokoro binary exists (which it doesn't as of 2026-05-26 in any public
 * release — retained for the case operator builds from source).
 */
async function synthesizeKokoro(
  text: string,
  opts: { voice?: string; speed?: number },
  bin: string,
  model: string,
  voices: string
): Promise<SynthesizeResult> {
  await fsp.mkdir(voiceCacheDir(), { recursive: true });
  const id = randomUUID().replace(/-/g, "");
  const outPath = path.join(voiceCacheDir(), `${id}.wav`);
  const voice = opts.voice || DEFAULT_KOKORO_VOICE;

  try {
    const args = [
      "--model", model,
      "--voices", voices,
      "--text", text,
      "--voice", voice,
      "--output", outPath,
    ];
    if (opts.speed && opts.speed > 0) args.push("--speed", String(opts.speed));

    const res = await spawnVoice(bin, args, { timeoutMs: 60_000 });
    if (res.exitCode !== 0) {
      throw new Error(
        `kokoro exited ${res.exitCode}: ${res.stderr || "(no stderr)"}`
      );
    }
    const wav = await fsp.readFile(outPath);
    return {
      wav,
      durationMs: res.durationMs,
      voice,
      charCount: text.length,
    };
  } finally {
    await fsp.unlink(outPath).catch(() => {});
  }
}
