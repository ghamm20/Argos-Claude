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
// Tool location: <ARGOS_F5_HOME>/venv/Scripts/  (default: ~/dev/f5-tts)
//   Override with ARGOS_F5_HOME (the f5-tts dir that contains venv/).
// Device: ARGOS_F5_DEVICE (cuda|cpu), default cuda. On an 8GB card with Bart's
// 9.6GB model resident, GPU inference still works via WDDM VRAM oversubscription
// (measured ~2.0GB peak, ~0.7x realtime); set cpu to avoid any GPU contention.

import { promises as fsp, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
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

/** Return the F5 inference CLI path inside `home`/venv if it exists, else null. */
function cliPathIn(home: string): string | null {
  const win = path.join(home, "venv", "Scripts", "f5-tts_infer-cli.exe");
  if (existsSync(win)) return win;
  const posix = path.join(home, "venv", "bin", "f5-tts_infer-cli");
  if (existsSync(posix)) return posix;
  return null;
}

/** Candidate F5 install roots, in priority order. ARGOS_F5_HOME wins; otherwise
 *  we auto-detect common locations so the operator doesn't have to set the env
 *  var (no hardcoded absolute paths — all derived; USB-native Rule 1). */
function f5HomeCandidates(): string[] {
  return [
    process.env.ARGOS_F5_HOME,
    path.join(os.homedir(), "dev", "f5-tts"),
    path.join(os.homedir(), "f5-tts"),
    path.join(argosRoot(), "..", "f5-tts"),
    path.join(argosRoot(), "tools", "f5-tts"),
  ].filter((c): c is string => !!c);
}

/** F5-TTS install root (contains venv/). Returns the first candidate whose
 *  venv CLI actually exists; else the preferred default (for messaging). */
export function f5Home(): string {
  for (const c of f5HomeCandidates()) {
    if (cliPathIn(c)) return c;
  }
  return process.env.ARGOS_F5_HOME || path.join(os.homedir(), "dev", "f5-tts");
}

/** Resolve the F5-TTS inference CLI. Probes all candidate homes. null if absent
 *  or if F5 is explicitly disabled via ARGOS_F5_DISABLE=1 (operator switch to
 *  force Bartimaeus back onto Piper). */
export function f5Cli(): string | null {
  if (process.env.ARGOS_F5_DISABLE === "1") return null;
  for (const c of f5HomeCandidates()) {
    const cli = cliPathIn(c);
    if (cli) return cli;
  }
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

// ----- persistent daemon (eliminates the per-call cold load) -----

/** Daemon listen port. Override via ARGOS_F5_PORT. */
export function f5DaemonPort(): number {
  const n = Number(process.env.ARGOS_F5_PORT);
  return Number.isFinite(n) && n > 0 ? n : 7880;
}
function f5DaemonBase(): string {
  return process.env.ARGOS_F5_DAEMON_URL || `http://127.0.0.1:${f5DaemonPort()}`;
}

/** The daemon server script (ships under ARGOS_ROOT/tools/voice/f5-daemon). */
export function f5DaemonScript(): string {
  return path.join(voiceToolsDir(), "f5-daemon", "server.py");
}

/** venv python that runs the daemon. null if absent. */
function f5Python(): string | null {
  const winp = path.join(f5Home(), "venv", "Scripts", IS_WINDOWS ? "python.exe" : "python");
  if (existsSync(winp)) return winp;
  const posix = path.join(f5Home(), "venv", "bin", "python");
  if (existsSync(posix)) return posix;
  return null;
}

/** Is the daemon up with the model loaded? Cheap probe, short timeout. */
export async function isF5DaemonHealthy(timeoutMs = 1200): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${f5DaemonBase()}/health`, { signal: ctrl.signal }).finally(() =>
      clearTimeout(t)
    );
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean; ready?: boolean };
    return !!j.ok && j.ready !== false;
  } catch {
    return false;
  }
}

// Module-scope guard so a burst of requests only spawns one daemon.
let daemonStarting = false;

/** Best-effort: start the daemon detached so it warms for the NEXT call.
 *  Never throws, never blocks the current request. */
export function tryStartF5Daemon(): void {
  if (daemonStarting) return;
  const py = f5Python();
  const script = f5DaemonScript();
  if (!py || !existsSync(script)) return;
  daemonStarting = true;
  try {
    const child = spawn(py, [script], {
      cwd: f5Home(),
      env: {
        ...process.env,
        ARGOS_ROOT: argosRoot(),
        ARGOS_F5_PORT: String(f5DaemonPort()),
        ARGOS_F5_DEVICE: f5Device(),
        ARGOS_F5_MODEL: f5Model(),
      },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* best-effort */
  }
  // Allow a retry later if the daemon didn't actually come up.
  const reset = setTimeout(() => {
    daemonStarting = false;
  }, 60_000);
  reset.unref?.();
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
  daemonPort: number;
  daemonScript: string | null;
  reason: string | null;
} {
  const cli = f5Cli();
  const ref = bartReferenceWav();
  let reason: string | null = null;
  if (process.env.ARGOS_F5_DISABLE === "1") reason = "F5-TTS disabled via ARGOS_F5_DISABLE=1.";
  else if (!cli) reason = `F5-TTS CLI not found under ${f5Home()}\\venv (install F5-TTS or set ARGOS_F5_HOME).`;
  else if (!ref) reason = `Bartimaeus reference clip missing at ${bartReferenceDir()}\\bart-ref.wav.`;
  return {
    available: !!cli && !!ref,
    cli,
    referenceWav: ref,
    hasReferenceText: !!bartReferenceText(),
    device: f5Device(),
    home: f5Home(),
    daemonPort: f5DaemonPort(),
    daemonScript: existsSync(f5DaemonScript()) ? f5DaemonScript() : null,
    reason,
  };
}

const F5_TIMEOUT_MS = 180_000; // model load + inference; generous on cold CPU

const SPEECH_MAX_SENTENCES = 3;
const SPEECH_MAX_CHARS = 300;
const SPEECH_FALLBACK_CHARS = 150;

/**
 * Phase 7-D TTS speed: trim what we actually SPEAK so synthesis is punchy and
 * immediate. Bartimaeus writes long, markdown-laden replies sprinkled with
 * parenthetical stage directions; spoken in full that is 15–30s of synth and
 * sounds awkward. We voice a short lead-in only — the full reply stays readable
 * in the chat. Steps, in order:
 *   1. strip markdown links/images   [text](url) / ![alt](src) → text
 *   2. strip parenthetical asides     (anything in parentheses) — sound wrong spoken
 *   3. strip markdown markers         * _ ~ ` # > [ ]
 *   4. collapse whitespace
 *   5. take the first 3 sentences (split on . ! ?)
 *   6. hard-cap at 300 chars (cut on a word boundary)
 *   7. never empty — if cleaning emptied it, return the first 150 raw chars
 */
export function truncateSpeechText(input: string): string {
  const raw = (input ?? "").toString();

  let cleaned = raw
    // 1. markdown links / images → their visible text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 2. parenthetical stage directions — anything in parentheses
    .replace(/\([^)]*\)/g, " ")
    // 3. markdown emphasis / heading / quote / code / bracket markers
    .replace(/[*_~`#>[\]]/g, " ")
    // 4. collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  // 5. first N sentences (keep each terminator).
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g);
  let result =
    sentences && sentences.length
      ? sentences.slice(0, SPEECH_MAX_SENTENCES).join(" ").replace(/\s+/g, " ").trim()
      : cleaned;

  // 6. hard cap; prefer cutting on a word boundary in the back third.
  if (result.length > SPEECH_MAX_CHARS) {
    result = result.slice(0, SPEECH_MAX_CHARS);
    const lastSpace = result.lastIndexOf(" ");
    if (lastSpace > SPEECH_MAX_CHARS - 100) result = result.slice(0, lastSpace);
    result = result.trim();
  }

  // 7. never empty — fall back to first 150 raw chars.
  if (!result) return raw.trim().slice(0, SPEECH_FALLBACK_CHARS);
  return result;
}

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
  const refWav = bartReferenceWav();
  if (!refWav) {
    throw new Error("F5-TTS not available (reference clip missing)");
  }

  // Phase 7-D TTS speed: speak a punchy lead-in, not the whole essay. Trim once
  // here so BOTH the daemon and CLI paths synthesize the same short text.
  const speechText = truncateSpeechText(text);

  // Fast path: a warm daemon already holds the model in VRAM (~5s/clip).
  if (await isF5DaemonHealthy()) {
    return synthesizeViaDaemon(speechText);
  }

  // Daemon down: kick off a lazy start so the NEXT call is fast, and serve
  // THIS request via the CLI cold-load path (don't block the user ~30s on
  // model load). Per directive: falls back to CLI spawn when the daemon is down.
  tryStartF5Daemon();
  const cli = f5Cli();
  if (!cli) {
    throw new Error("F5-TTS not available (daemon down and CLI missing)");
  }
  return synthesizeViaCli(speechText, cli, refWav);
}

/** Synthesize via the persistent daemon over local HTTP (model already loaded). */
async function synthesizeViaDaemon(text: string): Promise<SynthesizeResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), F5_TIMEOUT_MS);
  try {
    const res = await fetch(`${f5DaemonBase()}/synth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, nfe_step: 64 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`f5 daemon ${res.status}: ${t.slice(0, 200)}`);
    }
    const wav = Buffer.from(await res.arrayBuffer());
    if (wav.length < 64) throw new Error("f5 daemon returned an empty WAV");
    return { wav, durationMs: Date.now() - start, voice: "bartimaeus-f5", charCount: text.length };
  } finally {
    clearTimeout(timer);
  }
}

/** Synthesize by spawning the F5 CLI (cold-loads the model each call). */
async function synthesizeViaCli(
  text: string,
  cli: string,
  refWav: string
): Promise<SynthesizeResult> {
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
    // Phase 7-C v2 (owner-approved): nfe_step 64. Raw F5 WAV — NO EQ.
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
    return { wav, durationMs: res.durationMs, voice: "bartimaeus-f5", charCount: text.length };
  } finally {
    await fsp.unlink(outPath).catch(() => {});
  }
}

/** Exposed for diagnostics/tests. */
export function f5ReferenceInfo(): { dir: string; argosRoot: string } {
  return { dir: bartReferenceDir(), argosRoot: argosRoot() };
}
