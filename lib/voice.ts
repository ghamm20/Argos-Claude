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
  /** TTS (Kokoro) status snapshot. */
  tts: {
    available: boolean;
    binary: string | null;
    model: string | null;
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
  const ttsBin = kokoroBinary();
  const ttsModelFile = await kokoroModel();
  const ttsVoices = await kokoroVoices();

  function sttReason(): string | null {
    if (sttBin && sttModel) return null;
    if (!sttBin && !sttModel)
      return `whisper binary + model missing. See tools/voice/README.md.`;
    if (!sttBin)
      return `whisper binary missing in ${whisperDir()}. Drop whisper-cli(.exe) there.`;
    return `whisper model missing in ${path.join(whisperDir(), "models")}. Drop a ggml-*.bin there.`;
  }
  function ttsReason(): string | null {
    if (ttsBin && ttsModelFile && ttsVoices) return null;
    if (!ttsBin && !ttsModelFile)
      return `kokoro binary + model missing. See tools/voice/README.md.`;
    if (!ttsBin)
      return `kokoro binary missing in ${kokoroDir()}. Drop kokoros(.exe) there.`;
    if (!ttsModelFile)
      return `kokoro model missing in ${path.join(kokoroDir(), "models")}. Drop a kokoro-*.onnx there.`;
    return `kokoro voices file missing (voices.bin / voices.json) in ${path.join(kokoroDir(), "models")}.`;
  }

  return {
    stt: {
      available: !!(sttBin && sttModel),
      binary: sttBin,
      model: sttModel,
      reason: sttReason(),
    },
    tts: {
      available: !!(ttsBin && ttsModelFile && ttsVoices),
      binary: ttsBin,
      model: ttsModelFile,
      voices: ttsVoices,
      reason: ttsReason(),
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

  await fsp.mkdir(voiceCacheDir(), { recursive: true });
  const id = randomUUID().replace(/-/g, "");
  const wavPath = path.join(voiceCacheDir(), `${id}.wav`);
  const outBase = path.join(voiceCacheDir(), `${id}-out`); // whisper appends .txt
  const txtPath = `${outBase}.txt`;

  await fsp.writeFile(wavPath, wav);

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

export const DEFAULT_KOKORO_VOICE = "af_bella";

/**
 * Synthesize text → WAV using Kokoro.
 *
 * The kokoros (Rust) binary supports both stdout streaming and
 * file-out. We use file-out for portability across forks. As with
 * whisper we route through state/voice/cache/<uuid>.wav.
 *
 * Different forks accept slightly different CLI flags (`-t/--text`,
 * `-v/--voice`, `-m/--model`, `-o/--output`). We pass the long forms
 * — least likely to collide. Document the expected fork in
 * tools/voice/README.md.
 */
export async function synthesizeText(
  text: string,
  opts: { voice?: string; speed?: number } = {}
): Promise<SynthesizeResult> {
  const bin = kokoroBinary();
  const model = await kokoroModel();
  const voices = await kokoroVoices();
  if (!bin || !model || !voices) {
    throw new Error(
      "voice TTS not configured: kokoro binary, model, or voices file missing. See tools/voice/README.md"
    );
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("voice TTS: empty text");
  }
  // Sanity cap. ~1500 chars ~ 90s of audio at typical Kokoro pace.
  // Saves the operator from accidentally synthesizing a 50KB blob.
  const TEXT_CAP = 4000;
  if (trimmed.length > TEXT_CAP) {
    throw new Error(
      `voice TTS: text too long (${trimmed.length} chars > ${TEXT_CAP} cap)`
    );
  }

  await fsp.mkdir(voiceCacheDir(), { recursive: true });
  const id = randomUUID().replace(/-/g, "");
  const outPath = path.join(voiceCacheDir(), `${id}.wav`);
  const voice = opts.voice || DEFAULT_KOKORO_VOICE;

  try {
    // Most kokoros forks accept the long flag set below. The exact
    // shape is documented in tools/voice/README.md so the operator
    // can swap a fork without code changes (or the README updates
    // both at once).
    const args = [
      "--model",
      model,
      "--voices",
      voices,
      "--text",
      trimmed,
      "--voice",
      voice,
      "--output",
      outPath,
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
      charCount: trimmed.length,
    };
  } finally {
    await fsp.unlink(outPath).catch(() => {});
  }
}
