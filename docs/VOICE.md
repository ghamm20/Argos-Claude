# Voice — Whisper STT + Kokoro TTS

ARGOS Phase 5 (v1.0) wires speech-to-text (Whisper) and text-to-speech (Kokoro) end-to-end. The binaries and models are **operator-supplied**, not bundled — see [installation](#installation) below. When the binaries are missing the UI silently hides its voice controls; nothing else changes.

## Architecture at a glance

```
ARGOS_ROOT/
  tools/voice/
    README.md                     # operator's install guide (this file in summary)
    whisper/
      whisper-cli(.exe)           # operator-provided
      models/
        ggml-base.en.bin          # operator-provided
    kokoro/
      kokoros(.exe)               # operator-provided
      models/
        kokoro-v1.0.onnx          # operator-provided
        voices-v1.0.bin           # operator-provided
  state/voice/cache/              # short-lived wav scratch dir (auto-created)
```

Source surfaces:

- `lib/voice.ts` — paths, capability detection, spawn helpers
- `lib/voice-client.ts` — browser MediaRecorder → 16 kHz mono WAV; TTS fetch
- `app/api/voice/status/route.ts` — capability snapshot (GET)
- `app/api/voice/stt/route.ts` — POST audio/wav → text
- `app/api/voice/tts/route.ts` — POST json → audio/wav
- `components/voice/MicButton.tsx` — composer mic
- `components/voice/PlayButton.tsx` — per-message TTS

## Why this shape

| Decision | Alternative | Why this one |
|---|---|---|
| Operator-supplied binaries | Bundle them in the repo | ARGOS doctrine forbids new deps without explicit owner approval. Whisper + Kokoro binaries are 100–300 MB platform-specific blobs. Operator installs once + keeps. |
| whisper.cpp (`whisper-cli`) | Python `openai-whisper`, `faster-whisper` | Single C++ binary, GGML quantized models, CPU-only viable, zero Python. Matches single-binary doctrine. |
| Kokoro (~80 M params) | Coqui XTTS / Piper / Bark | Fastest English TTS at this size, MIT-style license, ONNX runtime via `kokoros` Rust binary keeps the dep tree zero. |
| Disk-temp file IO | stdin/stdout streaming | `whisper-cli` and `kokoros` both accept file-in/file-out cleanly; stdin/stdout streaming varies by fork. State scratch dir under ARGOS_ROOT is Rule-5 compliant + survives the drive. |
| Browser-side WAV encode | Server-side ffmpeg convert | No new binary dep. `AudioContext` + `OfflineAudioContext` handle decode + resample in every modern browser. |
| Capability-gated UI | Always-render buttons | Operator never sees a button that 503s. The probe is cheap (only `fs.exists`). |
| Best-effort audit | Block-on-audit | Same doctrine as Phase 4 — voice should never fail because the chain is wedged. |

## Installation

Voice is OFF until you drop the binaries in. The launcher logs `[voice] whisper STT missing | kokoro TTS missing` at startup until you install them.

### 1. Whisper (STT)

1. Download a prebuilt whisper.cpp binary for your platform:
   - Windows: <https://github.com/ggerganov/whisper.cpp/releases> → `whisper-bin-x64.zip`
   - macOS:   `brew install whisper-cpp` and copy the `whisper-cli` binary
   - Linux:   build from source — `git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make` → copy `main` or `whisper-cli`
2. Place the binary at `ARGOS_ROOT/tools/voice/whisper/whisper-cli` (or `.exe` on Windows). `whisper`, `main` also accepted.
3. Download a GGML model:
   - `wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
   - `~75 MB` — fastest English baseline. For multilingual, use `ggml-base.bin` (no `.en`). For more accuracy: `ggml-small.en.bin` (~466 MB), `ggml-medium.en.bin` (~1.5 GB).
4. Place at `ARGOS_ROOT/tools/voice/whisper/models/ggml-base.en.bin`. Any `.bin` in that dir is accepted; `ggml-base.en.bin` is preferred if multiple are present.

Sanity check:

```
cd ARGOS_ROOT/tools/voice/whisper
./whisper-cli -m models/ggml-base.en.bin -f /path/to/test.wav -otxt -of /tmp/test --no-prints
cat /tmp/test.txt
```

### 2. Kokoro (TTS)

1. Download a prebuilt `kokoros` binary (Rust runtime for Kokoro):
   - Releases: <https://github.com/lucasjinreal/Kokoros/releases>
   - Or build: `git clone https://github.com/lucasjinreal/Kokoros && cd Kokoros && cargo build --release` → `target/release/kokoros`
2. Place at `ARGOS_ROOT/tools/voice/kokoro/kokoros` (or `.exe`).
3. Download the Kokoro ONNX model + voices file:
   - `wget https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1.0.onnx` (`~330 MB`)
   - `wget https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices-v1.0.bin` (`~6 MB`)
4. Place both at `ARGOS_ROOT/tools/voice/kokoro/models/`.

Sanity check:

```
cd ARGOS_ROOT/tools/voice/kokoro
./kokoros --model models/kokoro-v1.0.onnx --voices models/voices-v1.0.bin \
          --text "Hello from ARGOS" --voice af_bella --output /tmp/test.wav
```

If your `kokoros` fork takes different CLI flags, `lib/voice.ts → synthesizeText()` is the single place to adapt.

### 3. Verify

After installing both, restart ARGOS. The launcher now prints:

```
[voice] whisper STT ready  |  kokoro TTS ready
```

In the UI you'll see:

- A mic icon in the composer (tap to record)
- A speaker icon next to each assistant message (tap to play)

Or hit `GET http://127.0.0.1:7799/api/voice/status` directly:

```json
{
  "stt": { "available": true, "binary": "...", "model": "..." },
  "tts": { "available": true, "binary": "...", "model": "...", "voices": "..." }
}
```

## API surface

### `GET /api/voice/status`

Returns the capability snapshot above. Cheap; safe to poll. Always 200.

### `POST /api/voice/stt`

```
Content-Type: audio/wav
Body: 16 kHz mono 16-bit PCM WAV
```

Response (200):

```json
{ "text": "transcribed words...", "durationMs": 1230, "modelBasename": "ggml-base.en.bin", "audioBytes": 32044 }
```

Query params:

| param | effect |
|---|---|
| `?lang=en` | Language hint passed to whisper (`-l en`) |
| `?sessionId=ID` | Scope the audit entry to a session |

503 when whisper isn't installed (with a `hint` field pointing at this doc). 413 if audio > 25 MB.

### `POST /api/voice/tts`

```
Content-Type: application/json
{ "text": "hello", "voice": "af_bella", "speed": 1.0, "sessionId": "..." }
```

Response (200):

```
Content-Type: audio/wav
x-voice-engine: kokoro
x-voice-name: af_bella
x-voice-duration-ms: 480
x-voice-char-count: 5
<binary WAV>
```

503 when kokoro isn't installed. 400 if `text` empty or > 4000 chars.

`GET /api/voice/tts` returns the default voice name + the POST signature — useful as a quick sanity check.

## Audit chain

Two new event kinds (extending `lib/audit.ts → AuditKind`):

| kind | payload |
|---|---|
| `voice.transcribed` | `durationMs, charCount, audioBytes, modelBasename, language` |
| `voice.spoken` | `charCount, voice, durationMs, audioBytes` |

Both writers are best-effort — a failed audit append never blocks the underlying voice op. Same doctrine as Phase 4 surfaces.

## Failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| Binary missing | API 503 with `hint`; UI button hidden; launcher logs `missing` | Drop the binary in the right dir; refresh the UI |
| Model missing | Same as binary missing (capability detection treats both as fatal) | Drop the model file in `models/` |
| Mic permission denied (browser) | MicButton enters error state for 2.5 s | Approve mic permission in the browser, click again |
| Whisper times out (>120 s) | API 500 with `voice binary timed out` | Audio too long? Cap inbound recording (60 s default in MicButton) |
| Kokoro returns non-zero exit | API 500 with stderr included | Check kokoros fork compatibility; `synthesizeText` in `lib/voice.ts` documents expected flags |
| Cache dir unwriteable | API 500; voice broken | Free space on the drive; cache lives at `$ARGOS_ROOT/state/voice/cache/` |

## Doctrine compliance

- **Rule 1** (zero host persistence): all binaries + models + cache under `ARGOS_ROOT/tools/voice/` and `ARGOS_ROOT/state/voice/`. Removable with the drive.
- **Rule 2** (no network deps): browser captures local mic only; server spawns local binaries only. No remote API.
- **Rule 5** (no remote fetch): everything stays on `127.0.0.1`.
- **Rule 6/7** (launcher discipline): voice presence-check is a read-only probe, not a daemon spawn, so the existing Rule 6/7 gates don't apply to it.

`verify-argos`: all 7 rules PASS on Phase 5 source.

## See also

- `lib/voice.ts` — server-side orchestration
- `lib/voice-client.ts` — browser audio capture
- `docs/AUDIT.md` — chain + audit event lifecycle
- `methodology/decisions.md` — Phase 5 entry with rationale + alternatives considered
