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
 * shorter gets zero-padded up to this floor.
 *
 * Why: whisper.cpp's small.en model reliably hallucinates on very
 * short clips — a 400ms "hello" comes back as "you", a 600ms "stop"
 * comes back as phantom sentences. The model needs enough context
 * to anchor against real speech; below ~1.5s its prior takes over
 * and it confabulates. Padding with PCM silence (zero bytes) gives
 * the encoder dead air to chew on without changing the transcript.
 */
const MIN_STT_SECONDS = 1.5;

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

  // Short-utterance defense — pad to MIN_STT_SECONDS of silence so
  // whisper-cli has enough audio context to avoid hallucinating on
  // sub-second clips. No-op for any clip already at/above the floor.
  const wavForWhisper = padWavToMinDuration(wav, MIN_STT_SECONDS);

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
  opts: { voice?: string; speed?: number } = {}
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
