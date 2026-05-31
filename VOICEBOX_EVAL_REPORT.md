# VOICEBOX_EVAL_REPORT.md — Phase 7-C: Voicebox TTS Evaluation

**Date:** 2026-05-31
**Author:** Claude
**Dev source:** `C:\Users\Gordy\dev\Argos-Claude` (HEAD `e668f35`)
**Deployed payload:** `D:\ARGOS`
**Scope:** Evaluation only — **no code changes, nothing installed, nothing wired.** Findings from reading the current voice code + public Voicebox/F5-TTS documentation.
**Candidate:** Voicebox (`jamiepine/voicebox`) as primary TTS for Bartimaeus; voice-clone target Simon Jones (Bartimaeus audiobook); hardware RTX 3060 Ti / 8 GB VRAM.

> **Headline recommendation: KEEP PIPER as the shipping default; do NOT adopt Voicebox as ARGOS's primary in-app TTS.** Voicebox is a strong *desktop voice studio* but is a heavy host-installed Python/CUDA/Tauri app that breaks ARGOS's USB-native doctrine, and its quality voice-clone engines contend for the same 8 GB VRAM the LLM already overflows. Treat Voicebox (or F5-TTS) as an **optional, operator-host, offline cloning studio** — and revisit GPU-resident real-time cloning when the 5090 lands. Details + risks below.

---

## 1. Current Piper TTS architecture (Task 1)

### Flow
```
ChatPane PlayButton (components/voice/PlayButton.tsx)
   │  POST { text, personaId, sessionId }
   ▼
app/api/voice/tts/route.ts        ── capability gate (503 if unavailable) ──┐
   │  resolves voice: explicit `voice` → persona.voiceId → DEFAULT_PIPER_VOICE
   ▼
lib/voice.ts  synthesizeText()
   │  engine select: Piper (preferred) → Kokoro (fallback) → throw
   ▼
synthesizePiper():  spawn  piper.exe  --model <voiceId>.onnx  --output_file <tmp>.wav
   │  text piped via STDIN; WAV read back from tmp; tmp unlinked
   ▼
returns audio/wav  +  x-voice-engine / x-voice-name / x-voice-duration-ms headers
   │  best-effort audit:  voice.spoken
   ▼
browser <audio> (PlayButton, with setSinkId output-device routing from the voice-output phase)
```

### Files
| File | Role |
|---|---|
| `lib/voice.ts` | Core orchestration. Path resolution (all under `$ARGOS_ROOT/tools/voice/`), `detectVoiceCapability()` (stat-only, no spawn), `synthesizeText()` dispatch, `synthesizePiper()` / `synthesizeKokoro()`, Whisper STT (`transcribeWav` + WAV trim/pad helpers). |
| `app/api/voice/tts/route.ts` | TTS endpoint. Capability gate → voice resolution → `synthesizeText` → `audio/wav`. Audit `voice.spoken`. |
| `app/api/voice/stt/route.ts` | STT endpoint (Whisper). |
| `app/api/voice/status/route.ts` | Cheap capability snapshot for the UI; always 200. |
| `components/voice/{PlayButton,MicButton,SpeakerSelect}.tsx` | UI: speak assistant msgs, record mic, choose output sink. |
| `lib/personas.ts` | Each persona carries a `voiceId` (Bart `en_US-ryan-high`, Juniper `en_US-amy-medium`, Sage `en_US-lessac-high`, Bobby `en_US-joe-medium`). |
| `tools/voice/piper/` | Binary + DLLs + `espeak-ng-data/` + `voices/*.onnx`. ~834 MB whole voice subsystem incl. Whisper. |

### Key properties (these define the integration constraints)
- **Spawn-per-request CLI.** No persistent service; each TTS call forks `piper.exe`, pipes text, reads a WAV. Stateless, crash-isolated, trivially cleaned up.
- **CPU-only ONNX inference. Zero VRAM.** Piper does not touch the GPU. Measured 613 ms (Bobby) → 1532 ms (Sage) per utterance — well under the 3 s target. **This is why voice + LLM coexist fine today: they don't share the GPU.**
- **USB-native, zero host install.** Everything under `$ARGOS_ROOT/tools/voice/`. Survives the D: migration unchanged; honors Seven-Rules #1.
- **Fixed pretrained voices — NO cloning.** Voices are `rhasspy/piper-voices` ONNX files. **Bart's "voice" today is a generic deep male preset (Ryan), not Simon Jones.** Piper cannot clone from reference audio. This is the actual gap motivating Phase 7-C.
- **Engine-pluggable already.** `synthesizeText()` is a dispatcher (Piper → Kokoro → throw). Adding a third backend is a localized change (see §3).

---

## 2. Voicebox capability assessment (Task 2)

Source: `github.com/jamiepine/voicebox`, `voicebox.sh`, project docs. **Not installed or run** (per constraints — see Risk R5).

| Question | Finding |
|---|---|
| **What is it?** | "Open-source AI voice studio. Clone, dictate, create." A **Tauri desktop app** (Rust shell + Bun JS frontend + **Python FastAPI** backend) positioned vs ElevenLabs/Whisper Flow. Multi-track timeline editor, global push-to-talk dictation, MCP server. |
| **Maturity** | ~29k stars, ~588 commits, **v0.5.0 (Apr 2026)**, MIT license, active (356 open issues). Mature for a desktop app; **young as an embeddable engine.** |
| **What it needs to run locally** | **Python 3.11+, Bun, Rust, Tauri prerequisites.** GPU backends: CUDA (PyTorch) on NVIDIA, plus DirectML / ROCm / MLX / CPU. Windows install via **MSI**; Linux builds from source. The **CUDA backend pulls ~4 GB of PyTorch/CUDA DLLs.** |
| **Dependencies** | Heavy: a Python ML stack (PyTorch + CUDA), a Bun/Rust desktop runtime, multi-GB model downloads per engine. This is a full application, not a binary you drop in a folder. |
| **Voice cloning from reference audio?** | **Yes — zero-shot cloning** via its Chatterbox / Qwen CustomVoice engines, plus 50+ preset voices (Kokoro/Qwen). |
| **TTS engines exposed** | **Seven:** Qwen3-TTS (0.6B/1.7B), Qwen CustomVoice, **LuxTTS (~1 GB VRAM)**, Chatterbox Multilingual (23 langs), Chatterbox Turbo, TADA/HumeAI (1B/3B), **Kokoro (82M, ~negligible VRAM, presets only)**. **F5-TTS is NOT among them** (see §4). |
| **API / server mode?** | **REST API on `127.0.0.1:17493`**: `/generate`, `/speak`, `/transcribe`, `/profiles`, `/mcp`. Headless-capable in principle — this is the integration surface that matters for ARGOS. |
| **Runs on 3060 Ti / 8 GB?** | **Partially.** VRAM ranges **8–24 GB by engine.** Light engines fit easily (Kokoro negligible, LuxTTS ~1 GB) but **Kokoro = presets only (no clone)** and LuxTTS is lightweight/low-fidelity. The **cloning-capable engines (Chatterbox, Qwen3-TTS 1.7B, TADA) are the VRAM-hungry ones** and collide with the LLM (§4). CPU fallback exists but is **5–50× slower** — unusable for interactive Bart replies. |

**Net:** Voicebox is a capable, well-maintained *studio*. It does everything Piper does and adds real zero-shot cloning. Its weaknesses for ARGOS are entirely **deployment shape** (heavy host install) and **VRAM economics on 8 GB**, not capability.

---

## 3. Compatibility / integration path (Task 3)

**Can Voicebox integrate without a full rewrite? — Yes at the API layer; the cost is the runtime, not the code.**

Because Voicebox exposes a REST API and ARGOS already speaks HTTP to a local service (Ollama on 11434/11435), wiring Voicebox is a *small, localized* code change — the same shape as the existing engine dispatch.

### What STAYS (unchanged)
- `app/api/voice/tts/route.ts` — same request/response contract (`{text, personaId} → audio/wav`).
- `app/api/voice/status/route.ts`, capability-gate pattern, `voice.spoken` audit.
- All UI (`PlayButton`, `MicButton`, `SpeakerSelect`) + the persona `voiceId` field.
- The dispatcher shape in `synthesizeText()` (Piper → Kokoro → throw).
- Whisper STT path (Voicebox also offers `/transcribe`, but no reason to switch STT).

### What CHANGES (the localized work)
- Add a third branch in `synthesizeText()`: `synthesizeVoicebox(text, opts)` that does `POST http://127.0.0.1:17493/generate` (or `/speak`) and returns the WAV — replacing the `spawn(piper.exe)` shape with an `fetch()`.
- Extend `detectVoiceCapability()` to probe `:17493` (a cheap HTTP HEAD/GET) instead of stat-ing a binary, and add `"voicebox"` to the `engine` union.
- Re-interpret persona `voiceId`: today it's a Piper `.onnx` filename; for Voicebox it would be a **voice-profile id / cloned-profile name** (e.g. a "simon-jones" profile registered in Voicebox).
- A new `OLLAMA_HOST`-style config knob for the Voicebox base URL.

**Estimated code delta: ~1 file, ~60–100 lines.** Genuinely not a rewrite.

### …but the runtime change is NOT small
- ARGOS would now depend on a **separate, host-installed Voicebox process** (Python/CUDA/Tauri) running alongside the Next server + Ollama. The launcher would need to start/health-check a fourth service, OR the operator starts Voicebox manually.
- **This breaks USB-native (Seven-Rules #1).** Piper lives entirely under `$ARGOS_ROOT/tools/voice/` and writes nothing to the host. Voicebox is an MSI-installed app with a system Python env, ~4 GB of CUDA DLLs, and per-engine model caches in host locations. It cannot ride on the USB the way Piper does. A migrated `D:\ARGOS` would **no longer be self-contained** for voice.

> **Verdict on Task 3:** integration is technically easy (REST swap, ~1 file) but **architecturally expensive** (adds a heavyweight host dependency that violates the portability doctrine). The API shape is compatible; the deployment model is not.

---

## 4. Voice-clone feasibility on the 3060 Ti (Task 4)

This is the crux, and it's a **hardware-economics** problem, not a software one.

### The 8 GB VRAM is already overcommitted
From the D: launcher boot (`D:\ARGOS\logs\ollama.log`): the 3060 Ti reports `total 8.0 GiB, available 5.6 GiB`, and Bart's model (`royhodge812/Orchestrator:lates`, **9.6 GB**) **already exceeds 8 GB and spills to CPU.** There is no spare VRAM headroom while the LLM is resident.

### Real-time cloned TTS during chat needs the cloner resident *at the same time as the LLM*
Bart's replies are LLM-generated on the fly — you **cannot pre-render or cache** them. So a cloned-voice Bart needs the cloner loaded **concurrently** with the (already-overflowing) LLM. On 8 GB:

| Cloning engine | Inference VRAM | Fits beside the LLM on 8 GB? | Clone quality |
|---|---|---|---|
| **F5-TTS** (the referenced future arch) | ~3 GB | **No** — contends hard; both spill to CPU → slow | High; zero-shot from 5–15 s ref |
| **Chatterbox** (Voicebox) | ~3–4 GB class | **No** — same contention | High; zero-shot from ~5–10 s ref, emotion control |
| **Qwen3-TTS 1.7B** (Voicebox) | multi-GB | **No** | High |
| **LuxTTS** (Voicebox) | ~1 GB | Maybe, tight | Low-fidelity; weak/again-limited cloning |
| **Kokoro** (Voicebox/Piper-era) | ~negligible | Yes | **Presets only — cannot clone** |
| **Piper (today)** | 0 (CPU) | Yes | **Presets only — cannot clone** |

The pattern is unavoidable: **the engines that can clone Simon Jones are exactly the ones that won't fit beside the LLM on 8 GB; the engines that fit don't clone.**

### Reference audio for a Simon Jones clone
Both F5-TTS and Chatterbox zero-shot clone from **5–15 s** of clean reference. Sourcing a clean Simon Jones sample from the Bartimaeus audiobook is feasible, but note: **zero-shot captures timbre, not pacing/expression** — it flattens the dramatic delivery that makes the audiobook performance compelling. Recovering that needs **fine-tuning, which requires 16 GB+ VRAM** (out of reach on the 3060 Ti entirely).

### The 5090 changes the verdict
The operator profile notes a **5090 inbound**. A 32 GB card removes the coexistence squeeze entirely: a 9.6 GB LLM + a 3–4 GB cloner + headroom all fit resident, making **real-time F5-TTS/Chatterbox cloned-Bart genuinely viable**. **This is the single biggest reason to defer the cloning-engine decision rather than force it onto the 3060 Ti now.**

### About F5-TTS (the directive's referenced "architecture")
**Voicebox does not include F5-TTS.** Its zero-shot cloners are Chatterbox + Qwen CustomVoice. So "evaluate Voicebox before committing to F5-TTS" is a choice between *two different things*:
- **F5-TTS** = a single focused zero-shot cloning model (SWivid/F5-TTS), ~3 GB inference, that you'd wrap yourself (a small Python service ARGOS calls over HTTP — closer in spirit to how ARGOS already runs Ollama).
- **Voicebox** = a full multi-engine studio app that *includes a comparable cloner (Chatterbox)* plus a GUI, timeline editor, dictation, and 6 other engines.

If the end goal is *just a cloned Bart voice for ARGOS*, **F5-TTS (or a headless Chatterbox server such as `devnen/Chatterbox-TTS-Server`) is the leaner fit** — it's a single HTTP service you can run without the Tauri desktop shell. Voicebox's extra surface (GUI/timeline/dictation) is value for a human creator, not for ARGOS's programmatic TTS path.

---

## 5. Recommendation (Task 5): **KEEP PIPER + treat cloning as an optional, deferred, host-side studio (lean toward F5-TTS/Chatterbox-server over Voicebox for in-app use)**

Ranked:

1. **Ship Piper as the default in-app TTS (now).** It works, it's fast, it's CPU-only (no VRAM fight with the LLM), and it's the only option that stays USB-native on `D:\ARGOS`. Bart keeps the Ryan preset until a clone path is justified.
2. **Do NOT adopt Voicebox as ARGOS's primary/embedded TTS.** Its host-install Python/CUDA/Tauri footprint breaks Seven-Rules #1, and its quality cloners don't fit beside the LLM on 8 GB. The integration *code* is easy; the *deployment + hardware* cost is not worth it on current hardware.
3. **Hybrid, if cloning is wanted before the 5090:** run a **single headless cloning service on the operator's host** — **F5-TTS** or a **Chatterbox-TTS-Server** (both expose an HTTP API; ~3 GB) — and add a `synthesizeVoicebox`-style branch (~1 file) that ARGOS calls *when that service is up*, falling back to Piper when it isn't. This keeps the USB payload working standalone (Piper) and treats cloned-Bart as a **host-only enhancement**, exactly mirroring how ARGOS already treats Ollama as an external local service. Accept that on the 3060 Ti, cloned-Bart will be **slow** while the LLM is resident (both spill).
4. **Use Voicebox itself only as an offline creator tool** — e.g. to *audition* Simon-Jones clones or produce fixed audio assets — not as the runtime TTS engine ARGOS depends on.
5. **Revisit for real-time cloned-Bart when the 5090 arrives.** 32 GB makes F5-TTS/Chatterbox resident-alongside-LLM trivial; that's the right moment to commit to a cloning architecture and (optionally) reconsider Voicebox's REST backend then.

**One-line answer to the directive's question ("adopt Voicebox, keep Piper, or hybrid"):** **Keep Piper now; hybrid later via a *headless F5-TTS/Chatterbox service* (not the full Voicebox app); commit to GPU-resident cloning on the 5090.**

---

## 6. Risks & blockers

| # | Risk / blocker | Severity | Notes |
|---|---|---|---|
| **B1** | **USB-native doctrine break.** Voicebox is MSI-installed (Python 3.11+, Bun, Rust, ~4 GB CUDA DLLs, host model caches). Cannot live under `$ARGOS_ROOT`; a D: payload stops being self-contained for voice. | **Blocker** for "primary TTS." Conflicts with Seven-Rules #1. |
| **B2** | **8 GB VRAM coexistence.** LLM (9.6 GB) already overflows the 3060 Ti; a 3–4 GB cloner can't sit beside it. Quality clone engines won't fit; engines that fit can't clone. | **Blocker** for real-time cloned-Bart on current hardware. Resolved by the 5090. |
| **B3** | **Voicebox ≠ F5-TTS.** Voicebox bundles Chatterbox/Qwen, not F5-TTS. If F5-TTS specifically is the target architecture, Voicebox is a detour; wrap F5-TTS directly. | Medium | Clarifies the directive's premise. |
| **B4** | **New always-on dependency + lifecycle.** Adopting Voicebox/any GPU TTS adds a 4th service the launcher must start/health-check/tear down, plus model-download bootstrapping. More moving parts, more failure modes than spawn-per-request Piper. | Medium | The current Piper model is deliberately dependency-light. |
| **B5** | **This eval did not install or run Voicebox** (per the no-new-deps / read-before-write constraints). VRAM/latency figures for the *specific* cloning engines on *this* 3060 Ti are from documentation, not measured. A go/no-go on the hybrid path should include a one-off **host-side** install + a measured Chatterbox/F5-TTS latency test (flagged: that install is a host dependency, not USB-native, and needs approval). | Medium | Honest limitation of a read-only eval. |
| **B6** | **Clone fidelity ceiling on 3060 Ti.** Even if a cloner fits, zero-shot flattens pacing/expression; fine-tuning (which recovers it) needs 16 GB+. The audiobook *performance* won't fully reproduce until fine-tuning is possible (5090). | Low/Med | Sets expectations for "Simon Jones" realism. |
| **B7** | **Latency.** Piper is 0.6–1.5 s/utterance CPU. A contended GPU cloner on 8 GB (both LLM+TTS spilling) could be many seconds — degrading the conversational feel Bart needs. | Medium | Measure before committing (B5). |

---

## 7. What was NOT done (constraints honored)
- **No code changed, nothing wired** — read-only eval.
- **Nothing installed** — Voicebox/F5-TTS/Chatterbox were assessed from source + docs, not run. Any real measurement requires a **host install** (flagged as a non-USB-native dependency needing approval — B5).
- **No new npm dependencies.**
- **No GitHub push.**

Stopping after this report per directive. Nothing wired.

---

## Sources
- Voicebox repo + docs: https://github.com/jamiepine/voicebox · https://voicebox.sh/ · `docs/content/docs/overview/gpu-acceleration.mdx`
- F5-TTS: https://github.com/SWivid/F5-TTS · https://localaimaster.com/blog/f5-tts-setup-guide · https://realtimetts.com/f5-tts
- Chatterbox (headless server option): https://github.com/devnen/Chatterbox-TTS-Server · https://www.resemble.ai/learn/models/chatterbox
- Local TTS comparison (Piper/XTTS/F5/Bark/StyleTTS2): https://www.promptquorum.com/power-local-llm/local-tts-voice-cloning-piper-coqui-xtts
- ARGOS current wiring: `lib/voice.ts`, `app/api/voice/tts/route.ts`, `lib/personas.ts`, `PHASE_7B_REPORT.md` (this repo)
