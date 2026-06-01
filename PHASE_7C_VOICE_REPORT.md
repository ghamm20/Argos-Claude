# PHASE_7C_VOICE_REPORT.md — Bartimaeus F5-TTS Voice Clone

**Date:** 2026-06-01
**Author:** Claude
**Dev source:** `C:\Users\Gordy\dev\Argos-Claude` (HEAD `92666f2`)
**GPU:** RTX 3060 Ti / 8 GB VRAM · **Ollama:** 127.0.0.1:11434
**Status:** Implemented, tested, and **wired as production** — owner approved the v2 clone (no EQ). Production reference = **Bart3 [42.9–54.3 s]** ("Yes, I was Bartimaeus… But that was then."); inference = **nfe_step 64**, GPU. F5-TTS degrades gracefully to Piper when absent.

> **v2 update (owner-approved):** the first reference (Bart3 11.6–23.3, "whirl through the air…") sounded distant/recessed. Replaced with a forward, sardonic window — **Bart3 [42.9–54.3 s]**, *"Yes, I was Bartimaeus. Cheetah quick, strong as a bull elephant, deadly as a striking krait. But that was then."* — and raised inference quality to **nfe_step 64**. v2 measured: gen 6.88 s for 7.18 s audio (0.96×), peak VRAM 1990 MB (unchanged). Output raw (no EQ). This is now the committed production reference (`bart-ref.wav` + `bart-ref.txt`).

> **Bottom line:** F5-TTS cleanly clones Simon Jones's Bartimaeus delivery on this 8 GB card. It uses ~2.0 GB VRAM and runs at ~0.7× realtime on GPU — and it **does not OOM even with Bart's 9.6 GB model resident** (Windows WDDM pages idle GPU memory to RAM during TTS). CPU is **not** viable (36× realtime). Two honest caveats to weigh before wiring it permanently: (1) the current per-call CLI spawn cold-loads the model each time (~23 s/clip) — a persistent daemon would cut that to ~5 s; (2) the F5 toolchain lives outside ARGOS_ROOT and is **not** on the D: payload, so deployed Bart falls back to Piper until F5 is installed on the target.

---

## 1. F5-TTS install — details + version

| Item | Value |
|---|---|
| F5-TTS | **1.1.20** (`pip install f5-tts`) |
| Install location | `C:\Users\Gordy\dev\f5-tts\` (venv) — **outside ARGOS_ROOT** (it's a tool, not payload) |
| Python | 3.12.10 (venv off the Microsoft Store Python) |
| PyTorch | **2.6.0+cu124**, `torch.cuda.is_available() == True`, device = RTX 3060 Ti |
| Model | `F5TTS_v1_Base` (auto-downloaded ~1.35 GB safetensors) + Vocos vocoder |
| CLI | `venv\Scripts\f5-tts_infer-cli.exe` |

**Exact commands**
```
python -m venv C:\Users\Gordy\dev\f5-tts\venv
venv\Scripts\python -m pip install --upgrade pip
venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
venv\Scripts\python -m pip install f5-tts
```

**Prep-only extras (flagged — NOT ARGOS runtime/npm deps; used once to build the reference):**
- `faster-whisper 1.2.1` (pip, in the F5 venv) — transcribe the reference clip via a numpy array (CTranslate2, no ffmpeg).
- **ffmpeg 8.1.1** (winget `Gyan.FFmpeg`) — a host tool. F5-TTS's *auto-transcription* path needs it (transformers → torchcodec). **The production bridge avoids it entirely** by passing a pre-stored `ref_text`, so neither ffmpeg nor Whisper run at TTS time.

VRAM was **not** insufficient for the install/test — F5-TTS itself needs only ~2 GB (see §2), so I proceeded.

---

## 2. VRAM analysis — does F5 fit alongside Bart's 9.6 GB model?

Measured with `torch.cuda.max_memory_allocated()` + `nvidia-smi` + `ollama ps`.

| Scenario | F5 device | F5 peak VRAM | Gen time (6.37 s clip) | Realtime | Result |
|---|---|---|---|---|---|
| **A — Bart NOT loaded** | cuda | **1990 MB** (≈2.0 GB) | 4.73 s | 0.74× | ✅ comfortable (5.6 GB free) |
| **B — Bart RESIDENT** (9.6 GB, 68%/32% CPU/GPU; only **1.6 GB** free) | cuda | 1990 MB | 4.42 s | 0.69× | ✅ **NO OOM** — succeeded |
| **C — CPU fallback** | cpu | n/a | **231 s** | **36.3×** | ❌ unusable for interactive TTS |

**The key finding (Scenario B):** with Bart loaded, `nvidia-smi` showed only **1674 MB free**, yet F5 (needing ~2.0 GB) **ran successfully and did not crash**. On Windows the **WDDM driver oversubscribes VRAM** — it transparently pages part of Bart's *idle* GPU memory to system RAM while F5 runs, then restores it. This works because TTS happens *after* the LLM finishes generating (the model sits idle in VRAM during TTS), so paging it out is low-cost. After the run both coexisted (Bart still resident, 2.1 GB free).

**Caveats on relying on oversubscription:** it's robust here (modest ~0.4 GB oversubscription) but is a Windows/WDDM behavior, not a guarantee. If a future model leaves even less headroom it could thrash, and Bart's *next* token may pay a small re-page cost. The bridge therefore exposes `ARGOS_F5_DEVICE` — default `cuda` (validated), set `cpu` to eliminate GPU contention entirely (at the 36× cost).

**Verdict:** **F5 fits on GPU alongside Bart on this 8 GB card.** GPU is the only viable device. No model-offload juggling required for correctness, though it's available as a fallback.

---

## 3. Clone quality assessment

**Reference correction (important):** the directive pointed at `Bart1.wav`, but transcription revealed its **first ~21 s is the audiobook announcer intro** — *"Listening Library presents the Bartimaeus trilogy… Read for you by Simon Jones."* — not the character voice. Cloning from it would clone the **announcer**, not Bartimaeus. Surveying all three:
- **Bart1** — announcer intro + 3rd-person narration.
- **Bart2** — 3rd-person descriptive narration (Simon Jones, but not the character's first-person wit).
- **Bart3** — **first-person Bartimaeus**: *"Times change. Once, long ago, I was second to none… Yes, I was Bartimaeus… right now, I was lying in the middle of a midnight road, flat on my back, and getting flatter."* — the sardonic, dry delivery the clone needs.

So the reference is a clean **11.7 s clip of Bart3 (11.6–23.3 s)**, transcript pre-stored:
- `tools/voice/bart-reference/bart-ref.wav` (the clip)
- `tools/voice/bart-reference/bart-ref.txt` ("…to none. I could whirl through the air on a wisp of cloud and churn up dust storms with my passing. I could slice through mountains, raise castles")
- plus the three full `Bart1/2/3.wav` for provenance.

**Objective result:** F5-TTS produced a valid **24 kHz WAV** of the test phrase *"Ah. Another mortal requiring my considerable expertise. How refreshingly tedious."* from the correct first-person reference, using a SOTA zero-shot cloning model.

**Subjective result — OWNER REVIEW REQUIRED (honest):** I cannot listen to audio, so I will **not** claim it "sounds like" Simon Jones. The saved WAVs are for your ears:
- `C:\Users\Gordy\dev\f5-tts\out\bart_test_cuda.wav` (GPU)
- `C:\Users\Gordy\dev\f5-tts\out\bart_test_cpu.wav` (CPU, identical settings)

Please listen and judge timbre + the sardonic delivery before approving permanent wiring. If the clip's prosody is too "narration-flat," try a more wry reference window (e.g. Bart3 48.6–60 s, "…deadly as a striking krait. But that was then.").

---

## 4. Integration architecture

Persona-branched TTS, Piper untouched for everyone else, graceful F5→Piper fallback.

```
POST /api/voice/tts { text, personaId, voice?, speed? }
   │  capability gate: pass if Piper/Kokoro OR F5 available
   ▼
synthesizeText(text, { voice, speed, personaId })          [lib/voice.ts]
   │
   ├─ personaId === "bartimaeus" AND isF5Available()
   │      → synthesizeF5(text)   [lib/voice-f5.ts]  ── spawn f5-tts_infer-cli
   │            -m F5TTS_v1_Base -r bart-ref.wav -s <ref_text> -t <text>
   │            -o <cache> -w <uuid>.wav --nfe_step 64 --remove_silence --device cuda
   │      (any failure → falls through to Piper)
   │
   └─ else  → synthesizePiper(...)   [unchanged — all other personas]
   ▼
result { wav, durationMs, voice }   → 200 audio/wav, x-voice-engine: f5-tts | piper
```

**Files**
| File | Change |
|---|---|
| `lib/voice-f5.ts` *(new)* | F5 bridge: `f5Cli()`, `bartReferenceWav/Text()`, `isF5Available()`, `f5Status()`, `synthesizeF5()`. Graceful, same `SynthesizeResult` shape as Piper. Env: `ARGOS_F5_HOME`, `ARGOS_F5_DEVICE`, `ARGOS_F5_MODEL`. |
| `lib/voice.ts` | `synthesizeText` gains `personaId`; Bartimaeus → F5 (dynamic import, avoids circular dep) with Piper fallback. Piper path 100% unchanged. |
| `app/api/voice/tts/route.ts` | Gate also admits F5; passes `personaId` through; `x-voice-engine` reflects real engine (`f5-tts`/`piper`). |
| `app/api/voice/status/route.ts` | Adds `f5` status block (available, cli, referenceWav, device, reason). |
| `tools/voice/bart-reference/` *(new)* | `bart-ref.wav` + `bart-ref.txt` + `Bart1/2/3.wav`. Copied to `D:\ARGOS\tools\voice\bart-reference\` (confirmed present). |
| `scripts/smoke-voice-f5.mjs` *(new)* | Gate (14/14, §5). |

**Design choices:** ref_text is **pre-stored** → no Whisper/ffmpeg at runtime (USB-native friendly). The F5 venv stays outside ARGOS_ROOT (multi-GB tool, not payload). Bridge resolves it via `ARGOS_F5_HOME` (default the dev path); absent → `isF5Available()` false → Piper.

---

## 5. Latency measurements + smoke

**smoke-voice-f5.mjs — 14/14 PASS:**
- F5 status reports available (cli + reference clip present).
- Bartimaeus → **`x-voice-engine: f5-tts`**, real **158 KB RIFF WAV**.
- Other persona (Bobby) → **NOT** F5 (engine=none; 500 because Piper isn't installed here — routing correctly avoided F5; server stayed alive).
- F5 unavailable (`ARGOS_F5_HOME` bogus) → Bartimaeus **fell back** (no F5), graceful 503, no crash.
- Ran with **no ffmpeg on PATH** → confirms the runtime path is ffmpeg-free.

| Path | Latency (test phrase / short phrase) | Notes |
|---|---|---|
| F5 GPU, **warm** (Python API, model kept loaded) | **4.7 s** for 6.37 s audio (0.74×) | best case |
| F5 GPU, **bridge (CLI per call)** | **~23.4 s** for a 5-word phrase | **cold model+vocoder load every call** |
| F5 CPU | **231 s** (36×) | not viable |
| Piper (other personas) | n/a here (Piper not installed) | unchanged code path |

**The ~23 s bridge latency is the cold-load tax**: the CLI reloads the 1.35 GB model + vocoder on every invocation. A **persistent F5 daemon** (load once, serve over a local socket) would bring it to the ~5 s warm figure — recommended before this is a daily-use feature (see §6).

---

## 6. Deviations + blockers

1. **Reference source changed Bart1 → Bart3** — Bart1's first ~21 s is the audiobook announcer, not Bartimaeus. Used a clean first-person Bart3 clip (11.6–23.3 s). *Material to clone quality — flagged for owner review.*
2. **ffmpeg dependency, designed around** — F5 auto-transcription needs ffmpeg (transformers→torchcodec, which wants the "full-shared" DLL build). Avoided at runtime by pre-storing `ref_text` (transcribed once with faster-whisper, ffmpeg-free). ffmpeg + faster-whisper are **prep-only**, in the F5 venv / host — not ARGOS deps.
3. **Piper not installed on this box** — voice binaries are operator-supplied (Phase 5/7 design). So non-Bart personas have no voice *here*, and the smoke's "other persona" / "fallback" cases legitimately 5xx (asserted as *graceful + not-F5*, not as Piper audio). Install Piper per `docs/VOICE.md` to give the other three personas voice.
4. **F5 toolchain is not on the D: payload** — F5 lives at `C:\Users\Gordy\dev\f5-tts` (multi-GB venv, outside ARGOS_ROOT). On D:, `isF5Available()` is false → **Bart falls back to Piper**. To run the clone on D:, install F5 on that machine and set `ARGOS_F5_HOME` (the reference clip is already copied to D:). This is the honest USB-native limitation: a 5 GB PyTorch/CUDA tool can't ride along on the payload.
5. **Per-call cold load (~23 s)** — acceptable for an occasional "play this" button; too slow for heavy use. Recommend a persistent F5 daemon as a follow-up.
6. **GPU-only** — CPU is 36× realtime. The bridge defaults to `cuda`; `ARGOS_F5_DEVICE=cpu` exists only as a no-GPU-contention escape hatch.
7. **No commit/push** — per directive ("do not wire anything permanently until you review the clone quality and VRAM report"). All changes sit uncommitted in the working tree for your review.
8. **No new npm dependencies.** Piper not removed (untouched). Everything local.

---

## 7. Recommendation (for owner decision)

F5-TTS is viable on this hardware and the integration is clean + reversible. Before committing:
1. **Listen** to `bart_test_cuda.wav` — confirm it captures Simon Jones's Bartimaeus. (Re-pick the reference window if the delivery is too flat.)
2. Decide the **deployment story** — F5 only runs where the venv exists. Either (a) keep it dev-box-only and let D: fall back to Piper, or (b) install F5 on the target box(es).
3. If it becomes daily-use, approve a **persistent F5 daemon** to drop latency ~23 s → ~5 s.

On approval I'll commit the bridge + smoke + reference and (if requested) push.

**Phase 7-C complete. Stopping here — no permanent wiring committed pending your review.**
