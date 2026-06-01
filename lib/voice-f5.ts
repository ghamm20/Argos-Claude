// lib/voice-f5.ts
//
// Phase 7-C (2026-06-01) — F5-TTS bridge for Bartimaeus voice cloning.
//
// F5-TTS clones Simon Jones's Bartimaeus delivery from a short reference clip.
// It is a HEAVY external tool (PyTorch + CUDA, multi-GB venv) that lives
// OUTSIDE ARGOS_ROOT — it is NOT part of the USB payload. This module spawns
// the F5-TTS CLI the same way lib/voice.ts spawns Piper, and exposes the SAME
// SynthesizeResult shape so synthesizeText() can branch to it for Bartimaeus
// and keep Piper for every other persona.
//
// Graceful by construction: if the F5-TTS CLI or the reference clip is
// missing, isF5Available() is false and synthesizeText() stays on Piper — the
// chat/voice path never breaks. F5 failures throw; the caller falls back.
//
// Reference (committed, small): ARGOS_ROOT/tools/voice/bart-reference/
//   bart-ref.wav   ~11s clip of Simon Jones as Bartimaeus (first person)
//   bart-ref.txt   exact transcript of that clip
// Passing ref_text explicitly means F5 never auto-transcribes → no Whisper,
// no ffmpeg at runtime (keeps the deployed box light).
//
// Tool location (dev box): C:\Users\Gordy\dev\f5-tts\venv\Scripts\
//   Override with ARGOS_F5_HOME (the f5-tts dir that contains venv/).
// Device: ARGOS_F5_DEVICE (cuda|cpu), default cuda. On an 8GB card with Bart's
// 9.6GB model resident, GPU inference still works via WDDM VRAM oversubscription
// (measured ~2.0GB peak, ~0.7x realtime); set cpu to avoid any GPU contention.

import { promises as fsp, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "./vault/paths";
import {
  voiceToolsDir,
  voiceCacheDir,
  spawnVoice,
  type SynthesizeResult,
} from "./voice";

const IS_WINDOWS = process.platform === "win32";

/** F5-TTS install root (contains venv/). Override via ARGOS_F5_HOME. */
export function f5Home(): string {
  return process.env.ARGOS_F5_HOME || "C:\\Users\\Gordy\\dev\\f5-tts";
}

/** Resolve the F5-TTS inference CLI inside the venv. null if absent. */
export function f5Cli(): string | null {
  const name = IS_WINDOWS ? "f5-tts_infer-cli.exe" : "f5-tts_infer-cli";
  const full = path.join(f5Home(), "venv", "Scripts", name);
  if (existsSync(full)) return full;
  // POSIX venvs use bin/ not Scripts/
  const posix = path.join(f5Home(), "venv", "bin", "f5-tts_infer-cli");
  if (existsSync(posix)) return posix;
  return null;
}

/** Bartimaeus reference dir under ARGOS_ROOT (small, committed). */
export function bartReferenceDir(): string {
  return path.join(voiceToolsDir(), "bart-reference");
}

/** Resolve the reference WAV (the ~11s Bartimaeus clip). null if absent. */
export function bartReferenceWav(): string | null {
  const p = path.join(bartReferenceDir(), "bart-ref.wav");
  return existsSync(p) ? p : null;
}

/** Read the reference transcript. null if absent/empty. */
export function bartReferenceText(): string | null {
  try {
    const t = readFileSync(path.join(bartReferenceDir(), "bart-ref.txt"), "utf8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** F5 device — cuda by default; ARGOS_F5_DEVICE=cpu forces CPU (no GPU contention). */
export function f5Device(): "cuda" | "cpu" {
  return process.env.ARGOS_F5_DEVICE === "cpu" ? "cpu" : "cuda";
}

/** F5 model name. Override via ARGOS_F5_MODEL (default the v1 base). */
function f5Model(): string {
  return process.env.ARGOS_F5_MODEL || "F5TTS_v1_Base";
}

/**
 * True iff F5-TTS can actually serve a request: the CLI exists AND the
 * reference clip is present. Cheap (stat only) — safe to call per request.
 */
export function isF5Available(): boolean {
  return !!f5Cli() && !!bartReferenceWav();
}

/** Diagnostics for /api/voice/status. No process spawn. */
export function f5Status(): {
  available: boolean;
  cli: string | null;
  referenceWav: string | null;
  hasReferenceText: boolean;
  device: "cuda" | "cpu";
  home: string;
  reason: string | null;
} {
  const cli = f5Cli();
  const ref = bartReferenceWav();
  let reason: string | null = null;
  if (!cli) reason = `F5-TTS CLI not found under ${f5Home()}\\venv (install F5-TTS or set ARGOS_F5_HOME).`;
  else if (!ref) reason = `Bartimaeus reference clip missing at ${bartReferenceDir()}\\bart-ref.wav.`;
  return {
    available: !!cli && !!ref,
    cli,
    referenceWav: ref,
    hasReferenceText: !!bartReferenceText(),
    device: f5Device(),
    home: f5Home(),
    reason,
  };
}

const F5_TIMEOUT_MS = 180_000; // model load + inference; generous on cold CPU

/**
 * Synthesize text → WAV using F5-TTS with the Bartimaeus reference clip.
 * Same shape as lib/voice.ts synthesizeText() so callers are uniform.
 *
 * Spawns the CLI:
 *   f5-tts_infer-cli -m <model> -r <refWav> -s <refText> -t <text>
 *                    -o <outDir> -w <outName> --nfe_step 64 --remove_silence
 *                    --device <cuda|cpu>
 *
 * Throws if F5 is unavailable or the run fails — caller (synthesizeText)
 * catches and falls back to Piper so the chat path never breaks.
 */
export async function synthesizeF5(
  text: string,
  _opts: { speed?: number } = {}
): Promise<SynthesizeResult> {
  const cli = f5Cli();
  const refWav = bartReferenceWav();
  if (!cli || !refWav) {
    throw new Error("F5-TTS not available (CLI or reference clip missing)");
  }
  const refText = bartReferenceText();

  await fsp.mkdir(voiceCacheDir(), { recursive: true });
  const id = randomUUID().replace(/-/g, "");
  const outName = `${id}.wav`;
  const outPath = path.join(voiceCacheDir(), outName);

  const args = [
    "-m", f5Model(),
    "-r", refWav,
    "-t", text,
    "-o", voiceCacheDir(),
    "-w", outName,
    // Phase 7-C v2 (owner-approved): nfe_step 64 for higher-quality inference.
    // Output is the raw F5 WAV — NO EQ / post-processing.
    "--nfe_step", "64",
    "--remove_silence",
    "--device", f5Device(),
  ];
  // Explicit ref_text avoids F5's Whisper/ffmpeg auto-transcription path.
  if (refText) {
    args.splice(4, 0, "-s", refText);
  }

  try {
    const res = await spawnVoice(cli, args, { timeoutMs: F5_TIMEOUT_MS });
    if (res.exitCode !== 0) {
      throw new Error(`f5-tts exited ${res.exitCode}: ${res.stderr.slice(-300) || "(no stderr)"}`);
    }
    const wav = await fsp.readFile(outPath);
    if (wav.length < 64) {
      throw new Error("f5-tts produced an empty/invalid WAV");
    }
    return {
      wav,
      durationMs: res.durationMs,
      voice: "bartimaeus-f5",
      charCount: text.length,
    };
  } finally {
    await fsp.unlink(outPath).catch(() => {});
  }
}

/** Exposed for diagnostics/tests. */
export function f5ReferenceInfo(): { dir: string; argosRoot: string } {
  return { dir: bartReferenceDir(), argosRoot: argosRoot() };
}
