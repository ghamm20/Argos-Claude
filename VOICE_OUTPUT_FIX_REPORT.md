# VOICE_OUTPUT_FIX_REPORT

**Date:** 2026-05-27
**Scope:** TTS audio routes to the wrong output device — fix by adding an operator-pickable output device selector + `AudioContext.setSinkId()` in the playback path.

---

## 1. Root cause confirmation

**Confirmed: the previously-reported DeskIn Virtual Audio Device installs as both an input AND an output sink.** Operator's earlier "Chrome captures wrong mic" report (fixed by commit `e18ff5d` with the input device selector) was the input half. This commit fixes the output half — the WAV was generated correctly (smoke `phase7b-tts-smoke` 38/38), the `AudioContext` was unlocked correctly (commit `cd6bb78`), `source.start(0)` fired correctly, but the audio routed to the OS default output device, which on the operator's rig is DeskIn.

Inventory ruled out alternatives:
- `lib/voice-client.ts` — TTS pipeline returns the WAV bytes; no playback-side responsibility. Already 38/38 smoke green this session.
- `components/voice/PlayButton.tsx` — uses Web Audio API (`AudioContext` + `BufferSourceNode`), not `HTMLAudioElement`. So output routing is via `AudioContext.setSinkId()`, NOT `HTMLAudioElement.setSinkId()`. Chrome 110+ (Feb 2023) ships `AudioContext.setSinkId`; the operator's Chrome is recent.
- Module-scope shared `AudioContext` is created lazily inside `getSharedAudioContext()`. Routing decisions must happen on THIS context (not a new one) so the operator-gesture unlock from `cd6bb78` carries through.

**Where setSinkId fires in the playback chain:**
```
onClick → getSharedAudioContext() → ctx.resume()           [synchronous, gesture-bound]
       → start(ctx)                                         [async, gesture-chain broken — allowed]
            → fetch WAV
            → ctx.decodeAudioData(arrayBuf)
            → ctx.setSinkId(deviceId)   ← inserted here
            → ctx.createBufferSource()
            → source.connect(ctx.destination)
            → source.start(0)
```

The unlock happens synchronously on click; routing happens after the decode but before `source.start`. The gesture-chain constraint from `cd6bb78` is preserved — only `ctx.resume()` needs to be in the synchronous handler.

## 2. Files changed + line counts

| File | Change | Lines |
|---|---|---|
| `lib/voice-client.ts` | + `listAudioOutputs()`, + `MIC_DEVICE_LS_KEY` constant (moved here from MicButton), + `SPEAKER_DEVICE_LS_KEY` constant, + `getPersistedSpeakerId()` helper | +60 / -0 |
| `components/voice/SpeakerSelect.tsx` | NEW. Mirror of MicButton's selector pattern for `audiooutput` devices. | +137 / -0 |
| `components/voice/PlayButton.tsx` | Imports `getPersistedSpeakerId`, adds module-scope `setSinkIdUnsupportedLogged` flag + `ContextWithSetSinkId` type, calls `ctx.setSinkId(deviceId)` in `start()` after decode, before `createBufferSource()`. | +51 / -1 |
| `components/voice/MicButton.tsx` | Imports `MIC_DEVICE_LS_KEY` from voice-client instead of defining inline. | +1 / -3 |
| `components/ChatPane.tsx` | Imports `SpeakerSelect`, renders it inside the composer wrap immediately above MicButton. | +6 / -0 |
| `VOICE_OUTPUT_FIX_REPORT.md` | NEW (this file). | +N |

## 3. `setSinkId` support detection logic

PlayButton uses structural typing (`AudioContext & { setSinkId: (...) => Promise<void> }`) to feature-detect because `lib.dom.d.ts` doesn't ship `setSinkId` on `BaseAudioContext` everywhere yet. Three branches at runtime:

```typescript
const speakerId = getPersistedSpeakerId();
if (speakerId) {
  const ctxAny = ctx as Partial<ContextWithSetSinkId>;
  if (typeof ctxAny.setSinkId === "function") {
    try {
      await (ctxAny as ContextWithSetSinkId).setSinkId(speakerId);
    } catch (err) {
      // (a) Routing failure: device unplugged, busy, permission denied.
      // Logged but non-fatal — fall through to default sink.
      console.warn("[PlayButton] setSinkId failed (falling back to default sink):", err);
    }
  } else if (!setSinkIdUnsupportedLogged) {
    // (b) Browser doesn't support setSinkId (Chrome < 110, Firefox).
    // Log once per page load; fall through to default sink.
    setSinkIdUnsupportedLogged = true;
    console.warn("[PlayButton] AudioContext.setSinkId is not supported...");
  }
}
// (c) No persisted speakerId → skip routing entirely → default sink.
```

All three failure modes degrade gracefully to "play on the OS default sink" — never blocks playback. Worst case is the pre-fix baseline (which is what older Chrome would see anyway).

## 4. SpeakerSelect layout

The two selectors stack vertically above the mic button at the same right offset. Composer area now (sketch — actual elements are absolute-positioned in the `relative` textarea wrap):

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  [ Speakers (HP Headphones) ▾ ]    ← SpeakerSelect          │ bottom-20
│  [ Microphone (C922 Pro Stre…) ▾]  ← mic device dropdown    │ bottom-11
│                                                            │
│  Message Bartimaeus (Cmd/Ctrl+…) [🎙 Speak] [SEND]         │ bottom-1.5
│                                                            │
└────────────────────────────────────────────────────────────┘
```

Both selectors are `right-[5.5rem]`, `max-w-[14rem]`, `truncate`, persona-accent outline ring. Same `<select>` element styling. Read as a coordinated audio-routing pair. Each one self-hides when there's only one device of its kind — single-output / single-input rigs see no dropdown clutter.

## 5. Build + smoke output

| Step | Result |
|---|---|
| `npm run lint` | ✅ clean (no warnings) |
| `npm run typecheck` | ✅ clean (no errors — `ContextWithSetSinkId` structural type compiles cleanly under current `lib.dom.d.ts`) |
| `npm run build` | ✅ 22 routes compiled, no warnings |
| `node scripts/smoke-v1-e2e.mjs` | ✅ **23/23 PASS** |
| `node scripts/phase7-stt-smoke.mjs --argos-root <Desktop\ARGOS>` | ✅ **10/10 PASS**. STT pipeline unaffected (no audio output paths touched server-side). |
| `node scripts/phase7b-tts-smoke.mjs --argos-root <Desktop\ARGOS>` | ✅ **38/38 PASS**. TTS WAV generation unchanged — fix is purely client-side playback routing. |

## 6. Commit hash

**`5711aee`** — `fix(voice): add output device selector + AudioContext.setSinkId routing — fixes silent TTS when default sink is virtual`

6 files changed, 416 insertions(+), 5 deletions(-). Local-only, not pushed (per standing rule).

## 7. Honest findings worth flagging

1. **Smokes can't exercise setSinkId.** No browser in the test loop. The selector enumeration, persistence, and `setSinkId` call all rest on operator manual validation (browser console + clicking Speak with a real device selected).
2. **First Speak after a page reload uses whatever sink Chrome resumed with**, until the operator picks an output. The auto-default-pick avoids virtual devices via the same blacklist as the mic selector — but it only writes the choice to localStorage when the operator EXPLICITLY clicks the dropdown. Otherwise the first click uses the soft default (no setSinkId call fires; speakerId is null in localStorage). This is intentional: don't silently lock the operator into a guess.
3. **Labels populate after first mic permission grant.** Chrome ties `MediaDeviceInfo.label` visibility to mic permission. Operator who hasn't yet clicked the mic button will see `Speaker (xxxxxx)` placeholders in the dropdown. First successful Speak click does NOT trigger mic permission, so the workaround is: click the mic button once (then cancel if you don't want to record), and from then on the speaker labels are real names. Could be addressed by triggering a no-op getUserMedia in SpeakerSelect's mount, but that would pop a mic-permission dialog just for picking a speaker — too intrusive.
4. **Virtual-device blacklist duplicated** between MicButton and SpeakerSelect, with an inline comment explaining the duplication is intentional. Output and input blacklists may diverge over time (e.g. "stereo mix" is virtual-input-only; future entries might be one-sided). Cheaper to maintain two short lists than to share one and special-case the divergence.
5. **`MIC_DEVICE_LS_KEY` constant moved** from MicButton.tsx to voice-client.ts as part of this commit. MicButton now imports the constant from the canonical location. Behavior unchanged — the localStorage key string is the same (`argos_mic_device_id`), so any operator with a previously-saved mic choice keeps it.

---

## Gate criteria — all met

✅ SpeakerSelect dropdown visible above mic selector when >1 output device exists (auto-hides on single-output rigs)
✅ Persistence to localStorage `argos_speaker_device_id` confirmed in code path (set on every dropdown change with try/catch around localStorage)
✅ `AudioContext.setSinkId(deviceId)` called inside `PlayButton.start()` after `decodeAudioData` and before `createBufferSource()` — gesture chain preserved (resume still synchronous on click)
✅ Build clean (lint + typecheck + build)
✅ Smokes pass (23 + 10 + 38 = 71 assertions across 3 harnesses)

## Operator manual test sequence

1. Boot ARGOS via `ARGOS.lnk` and reload the chat page (so the new bundle loads).
2. Look at the composer right side: two dropdowns visible stacked above the "🎙 Speak" mic button. Top = outputs (speakers / headphones / DeskIn), bottom = inputs (C922).
3. (Optional, but enables real device labels in the outputs dropdown if they're showing as `Speaker (xxxxxx)`): click the mic Speak button once to trigger the mic permission grant, then cancel.
4. Click the TOP dropdown and select your real speakers/headphones (NOT DeskIn).
5. Reload the page. Confirm the dropdown reopens with your choice persisted.
6. Send Bart a message, wait for the streaming response to finalize.
7. Click "▶ Speak" below his response.
8. Confirm Ryan's voice plays through the selected output device. If it still routes to DeskIn, open browser DevTools → Console — look for `[PlayButton] setSinkId failed` warnings, which will surface the underlying Chrome error.

## Standing rules respected
- No new npm dependencies.
- USB-native doctrine intact (localStorage is browser-scope, correct for "which speaker" persistence).
- Single commit.
- No push, no tag.
- Phase 9 NOT started.
- Out-of-scope items (per-message override, Settings tab UI, persona/model/prompt/STT/pad-trim changes) untouched.
