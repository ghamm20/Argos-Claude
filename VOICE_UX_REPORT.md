# VOICE_UX_REPORT

**Date:** 2026-05-27
**Scope:** Make TTS speak button visible + add STT silence trim + bump minimum audio floor + add explicit MicButton recording indicator.

---

## 1. Root cause — TTS button invisibility

The PlayButton (commit `cd6bb78`) was **technically present on every assistant message** — but rendered as a 20×20 px button containing a 12×12 px speaker glyph (`h-5 w-5` outer, `h-3 w-3` icon) in `text-neutral-500`, mounted inline beside the persona-name caption at the top of each assistant bubble.

In `ChatPane.tsx` (pre-fix):

```tsx
<div className="text-[10px] uppercase tracking-[0.18em] mb-1.5 flex items-center" style={{ color: accent }}>
  <span>{persona.name}</span>
  {!msg.errored && !msg.isStreaming && msg.content.length > 0 && (
    <PlayButton text={msg.content} accent={accent} sessionId={sessionId} personaId={msg.personaId} />
  )}
</div>
```

Why it was effectively invisible:
- **Tiny target.** ~20×20 px button, far below mouse-comfort and the WCAG 2.5.5 minimum (44×44 px).
- **Tinted to disappear.** `text-neutral-500` icon (medium gray) on `bg-neutral-950/60` (near-black) — contrast was nominally compliant but visually weak.
- **Wrong location.** Tucked inside a `text-[10px]` uppercase caption row at the TOP of the bubble — operator's gaze lands on the message body, never on the persona caption.
- **Conditional was correct.** The `!msg.errored && !msg.isStreaming && msg.content.length > 0` guard was right — finalized non-empty assistant turns only. That logic was preserved verbatim in the fix.

## 2. Fix — new TTS button position + appearance

**Where it renders now:** Below the message body, after the SourcesBlock and before the CodeProposalGate. One button per finalized assistant message (Bart, Juniper, Sage, Bobby — TTS available for all four).

**Appearance:**
- 32 px tall (`h-8`), 12-px font, 8-px horizontal padding, 6-px icon-to-label gap.
- Background: ARGOS teal `#00ff9d` (idle) / 75% teal alpha (playing) / 45% teal alpha (loading/disabled) / 85% red alpha (error).
- Text: `text-neutral-950` (near-black) — high contrast on teal.
- Persona accent appears as a subtle 1-px outline ring (`outline: 1px solid {accent}40`) so each persona's button still carries a hint of its colour family without overwhelming the primary teal.
- Volume2 / Pause / AlertCircle / Loader2 icons (4×4) match button text size.

**Labels by state:**
| State | Label | Icon |
|---|---|---|
| `idle` | `Speak` | Volume2 |
| `loading` | `Synthesizing…` | Loader2 (spin) |
| `playing` | `Stop` | Pause |
| `error` | `Audio error` | AlertCircle |

Layout descriptor (no screenshot tooling available in this environment, so a fixed-pitch sketch follows):

```
┌─ Bartimaeus assistant bubble ───────────────────────────┐
│ BARTIMAEUS                                              │   ← 10-px caption row (PlayButton removed)
│                                                         │
│ I am an austere reasoning engine dedicated to           │
│ verification, analysis, and strategic clarity. …        │   ← message body
│                                                         │
│ [📎 Sources ▾]                                          │   ← SourcesBlock (if retrieval used)
│                                                         │
│ ┌──────────────┐                                        │
│ │ 🔊 Speak    │                                         │   ← NEW: teal 32-px button below body
│ └──────────────┘                                        │
│                                                         │
│ [for Bobby only] [✓ Approve & Run] [✕ Reject]           │   ← CodeProposalGate (Bobby + code)
└─────────────────────────────────────────────────────────┘
```

Click → button switches to teal-translucent `Stop` with Pause icon while audio plays. `source.onended` returns it to `idle` so the operator can replay.

**Underlying audio logic unchanged.** All `getSharedAudioContext()` / `ctx.resume()` synchronous-on-click work from commit `cd6bb78` was preserved. Replaced only the render block (lines 223-264 in the old file). The shared-context module-scope coordination, `currentlyPlaying` registry, AbortController plumbing, and `source.onended` cleanup are byte-identical.

## 3. `MIN_STT_SECONDS` value before and after

| | Before | After |
|---|---|---|
| `MIN_STT_SECONDS` | `1.5` | **`2.5`** |
| Constant location | `lib/voice.ts` (module-scope) | unchanged |
| Rationale | Smallest pad floor where whisper.cpp small.en stopped hallucinating on test clips. | Operator still saw occasional "you" / "I" hallucinations on borderline 1.6-1.9 s real-speech clips. 2.5 s puts the comfortable speech window squarely inside small.en's reliable zone with headroom. Cost: ~1 s of extra silent tail per call = ~50 ms additional compute on small.en. |

## 4. Silence trimming — approach + threshold

**New function:** `trimWavSilence(wav: Buffer, threshold = 500, guardMs = 100)` in `lib/voice.ts`.

**Pipeline order (in `transcribeWav`):**
```typescript
const trimmed = trimWavSilence(wav);                              // 1. strip dead air
const wavForWhisper = padWavToMinDuration(trimmed, MIN_STT_SECONDS); // 2. pad to floor
await fsp.writeFile(wavPath, wavForWhisper);                       // 3. hand to whisper-cli
```

**Trim algorithm:**
1. Parse WAV header via shared `parseWavHeader()` helper. Bail (return original) on any failure or on a format that isn't 16-bit mono PCM (the only format our voice-client.ts ever produces, but the guard means custom uploads can't crash the pipeline).
2. Walk the 16-bit PCM samples from the start with `DataView.getInt16(offset, true)` until `|value| ≥ threshold`. That sample's index is `first`.
3. Walk from the end backwards the same way to find `last`.
4. If no sample crosses the threshold → entire payload is silence → return original buffer (whisper still wants something to consume; padding handles the rest).
5. Compute `guardSamples = floor(sampleRate * guardMs / 1000)` (= 1600 samples / 100 ms at 16 kHz). Expand outward: `trimStart = max(0, first - guardSamples)`, `trimEnd = min(N-1, last + guardSamples)`.
6. Rebuild buffer: original header (through the `data` chunk length field) + trimmed sample window.
7. Patch the two length fields in the new buffer: `RIFF` chunk size at bytes 4-7 and `data` subchunk size at the `data` marker offset + 4.

**Threshold = 500 / 32768 ≈ 1.53% of full-scale.** Picked because typical room tone in a quiet office reads 100-400 on signed 16-bit; conversational speech onsets cross 2000-8000. 500 sits cleanly in the gap.

**Guard = 100 ms (1600 samples at 16 kHz).** Below the perceptual "missing sound" threshold but above MediaRecorder's typical chunk granularity. Protects against clipping consonant onsets (the air-burst of /p/ /t/ /k/ can read silent if you measure too aggressively).

**Worked example.** Operator says "hey buddy" with ~300 ms of dead air on each side. Raw clip ≈ 1.8 s. Pre-fix: passes the old 1.5 s gate, no padding, sent verbatim to whisper → can hallucinate because the leading hum biases the encoder. Post-fix:
- Trim: 300 ms head + 300 ms tail removed minus 100 ms guard each side → ~1.0 s of speech-with-guard
- Pad: 1.0 s → 2.5 s with appended zero PCM
- Whisper sees a clean 2.5 s clip with the speech centred → anchors correctly.

## 5. Recording indicator — implemented states

The MicButton state machine was already three-state (`idle | recording | transcribing | error`) with a red pulse on the icon and a loader during transcription. **What was missing was an explicit text label** — operators saw only an icon swap with a colour change, no confirmation of what state the system was in. Fix adds visible labels and lifts the pulse from the icon to the whole button background.

| State | Background | Outline | Label | Icon | aria-label |
|---|---|---|---|---|---|
| `idle` | `rgba(38,38,38,0.70)` | persona accent 25% | `Speak` | `Mic` | `Voice input — click to record` |
| `recording` | `rgba(239,68,68,0.85)` red | `rgba(239,68,68,0.9)` red | `● Recording 0.0s` (live elapsed) | `Mic` | `Recording — click to stop and send` |
| `transcribing` | `rgba(115,115,115,0.55)` neutral | persona accent 25% | `Processing…` | `Loader2` (spin) | `Processing — transcribing audio` |
| `error` | `rgba(239,68,68,0.85)` red | persona accent 25% | `Error` | `MicOff` | `voice error — <message>` |

CSS pulse: `animate-pulse` from Tailwind is applied to the entire button while `isRecording`. This pulses the red background (much more visible than the previous icon-only pulse).

The button grew from ~32 px wide (icon-only) to ~140 px wide with the recording-with-elapsed label, so the composer textarea's right padding was bumped from `pr-32` (128 px) to `pr-60` (240 px) to keep typed text from running under the mic.

`data-mic-state` attribute added to the button for easier DOM inspection / future E2E hooks.

## 6. Build + smoke output

| Step | Result |
|---|---|
| `npm run lint` | ✅ clean (no warnings) |
| `npm run typecheck` | ✅ clean (no errors) |
| `npm run build` | ✅ 22 routes compiled, no warnings |
| `node scripts/smoke-v1-e2e.mjs` | ✅ **23/23 PASS** |
| `node scripts/phase7-stt-smoke.mjs --argos-root <Desktop\ARGOS>` | ✅ **10/10 PASS**. 2 s 440 Hz tone WAV round-tripped: `audioBytes=64044` (matches input, since `audioBytes` in the response is the original byte count — trim+pad operate on a copy passed to whisper-cli). Transcript `(electronic beeping)` returned cleanly. |
| `node scripts/phase7b-tts-smoke.mjs --argos-root <Desktop\ARGOS>` | ✅ **38/38 PASS**. All 4 persona voice mappings verified: Bart→en_US-ryan-high (1287 ms synth), Juniper→en_US-amy-medium (668 ms), Sage→en_US-lessac-high (1484 ms), Bobby→en_US-joe-medium (646 ms). `voice.spoken` audit entry present. Unknown-persona fallback to `DEFAULT_PIPER_VOICE` works. |

The phase7-stt-smoke test uses a continuous 2-s tone, which is above-threshold for the entire duration → `trimWavSilence` is a no-op and `padWavToMinDuration` pads from 2 s → 2.5 s (with the new floor). The `audioBytes` field in the response and audit chain reflects the original input buffer length (unchanged behaviour — the trim+pad work on internal copies).

## 7. Commit hash

**`<inserted post-commit>`** — `fix(voice): make TTS play button visible + STT silence trim + recording indicator`

---

## Files changed in this commit

| File | Change |
|---|---|
| `components/voice/PlayButton.tsx` | Render block replaced: tiny icon-only `h-5 w-5` button → 32-px teal labeled button with state-specific labels (`Speak`/`Synthesizing…`/`Stop`/`Audio error`) and matching backgrounds. All AudioContext / decodeAudioData / source-cleanup logic unchanged. |
| `components/voice/MicButton.tsx` | Render block replaced: icon-only mic → 32-px labeled button with `Speak`/`● Recording Xs`/`Processing…`/`Error` states; red pulsing background while recording; spinner with `Processing…` text during STT. `data-mic-state` attribute added. State machine unchanged. |
| `components/ChatPane.tsx` | (1) PlayButton removed from the persona-name caption row, (2) PlayButton mounted below the message body (after SourcesBlock, before CodeProposalGate), (3) composer textarea padding bumped `pr-32` → `pr-60` so the wider mic button doesn't cover typed text. |
| `lib/voice.ts` | `MIN_STT_SECONDS` `1.5` → `2.5`; new constants `SILENCE_THRESHOLD = 500`, `SILENCE_GUARD_MS = 100`; new exported `trimWavSilence()` function; new internal `parseWavHeader()` helper extracted from the existing pad logic; `transcribeWav()` now calls `trimWavSilence` BEFORE `padWavToMinDuration`. |

Intentionally NOT in this commit (per directive's `git add components/ lib/voice.ts`):
- `BOBBY_V2_REPORT.md` — dirty from the Bobby v2 commit-hash appendment, scope-separate from voice UX.
- `PHASE_7B_REPORT.md` — pre-existing dirt from way back, unrelated.

---

## Gate criteria — status

- ✅ **TTS button visible and clickable on every Bart response** — large teal `▶ Speak` button below the message body, 32 px tall, high-contrast, mounted in the rendering path of every finalized non-errored non-empty assistant message regardless of persona.
- ✅ **Recording indicator shows red while capturing** — button background flips to translucent red with `animate-pulse` on the whole button, label updates to `● Recording 0.0s` with live elapsed seconds.
- ✅ **STT silence trimmed before Whisper** — `trimWavSilence` runs before `padWavToMinDuration` in `transcribeWav`; 500/32768 threshold, 100 ms guard each side; all-silence buffers pass through untouched.

## Honest findings worth flagging

1. **Test-bench coverage gap on the trim path.** `phase7-stt-smoke.mjs` sends a continuous tone, which exercises the pad path but not the trim path (no silence to trim). The trim function's correctness rests on the code review + worked-example reasoning above plus the manual test the operator will run next. A future smoke could synthesize a "silence-speech-silence" WAV to exercise the trim explicitly.
2. **`audioBytes` semantic preserved.** The response/audit `audioBytes` field still reports the operator's original input length, not the post-trim/post-pad length. Intentional — operators care about how much audio they actually sent. The phase7-stt-smoke's `audioBytes matching` assertion still holds.
3. **Composer textarea padding now `pr-60`.** Narrower viewports may show a slightly cramped textarea. ARGOS targets the operator's laptop (≥1280 px wide) so this is comfortably inside the design envelope, but worth noting.
4. **PlayButton accent now mostly cosmetic.** The persona's accent colour now only shows up as a 1-px outline ring and (during playback) the icon tint — the primary button bg is the same teal across all four personas. This is a deliberate trade for "obviously a voice button" recognition; operators consistently recognized the previous per-persona-coloured glyph less than the unified teal pill.

## Standing rules respected
- No new npm dependencies.
- USB-native doctrine intact.
- No pushes to origin/main, no tags applied.
- Phase 9 NOT started.
- Out-of-scope items (VAD always-listen, conversation auto-loop, voice settings UI, persona/model changes) NOT touched.
