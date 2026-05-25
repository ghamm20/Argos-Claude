# ARGOS Operator Quickstart

You just plugged in the drive. Here's what to do.

If you only read one document, read this one. Anything more advanced lives in [`docs/05-OPERATIONS.md`](docs/05-OPERATIONS.md) (runbook), [`docs/06-V1.0-LOCKDOWN.md`](docs/06-V1.0-LOCKDOWN.md) (what ships), or the per-subsystem docs in `docs/`.

---

## 1. Boot

Pick your OS:

| OS | Command |
|---|---|
| **Windows** | Double-click `ARGOS\launcher.bat` from the USB drive |
| **macOS** | Right-click `ARGOS/launcher.command` → Open (first launch only, Gatekeeper) |
| **Linux** | `./launcher.sh` from a terminal |

The launcher banner shows:

```
 ARGOS - local-first AI workstation
 --------------------------------------------------------
 ARGOS_ROOT  E:\ARGOS
 Next.js     E:\ARGOS
 Ollama      E:\ARGOS\bin\ollama.exe
 Ports       Ollama 11434  Next.js 7799
 Logs        E:\ARGOS\logs\
```

About 8–10 seconds later (cold), your browser opens to `http://127.0.0.1:7799`. ARGOS is running.

**If you don't have a browser auto-open** (headless / SSH): open that URL yourself from any machine on the host.

---

## 2. First chat

The big eye in the center of the screen. **Bartimaeus is the default persona** — a strategist with a dry, truth-first voice. Type into the box, Cmd/Ctrl+Enter to send.

First reply takes ~3 seconds (cold load). Subsequent replies stream at 20-21 tok/s on an 8 GB RTX 3060 Ti.

If you want a different persona, click the gear icon (top-left). Four personas ship in v1.0:

| Persona | Voice | Best for |
|---|---|---|
| **Bartimaeus** (default, live) | dry, austere, strategic | Verification, analysis, push-back |
| **Sage** (selectable) | exhaustive, citation-heavy | Research, source synthesis |
| **Bobby** (selectable) | plain, blue-collar, no hedging | Quick practical answers |
| **Juniper** (selectable, stopgap) | warm, calm, grounding | Conversational, gentle delivery |

Bart + Sage share the `e4b` model (zero swap latency between them). Bobby + Juniper share `gemma2-2b` (also zero swap between them). Switching from a Bart/Sage to a Bobby/Juniper takes ~3 seconds (model swap).

---

## 3. Vault (optional — add your own documents)

To make ARGOS answer from your own material:

**Easiest path:**

Drop PDF / DOCX / MD / TXT files into `ARGOS_ROOT/vault/dropbox/` while ARGOS is running. The launcher's auto-ingest fires on boot; you can also POST to `/api/vault/auto-ingest` to re-scan mid-session. Successfully ingested files move to `vault/dropbox/.processed/`. Failures move to `.errored/`.

**UI path:**

Click the Vault tab → drag files onto the drop zone. Same effect.

**How it works in chat:**

- **Bart** (medium-confidence floor): retrieval auto-fires, only injects hits ≥0.40 cosine similarity
- **Sage** (low floor, top-10): retrieval auto-fires, aggressive — Sage's job is to surface source material
- **Bobby / Juniper** (opt-in): no retrieval unless you turn it on per-request

When retrieval fires, citations appear inline like `[1]`, `[2]`. Click the pill to see the source chunk in the citation drawer.

Confidence breakdown shows in the HUD as `Last: 4 hits · 2H 1M 1L` (high/medium/low buckets).

---

## 4. Voice (optional — operator-supplied)

v1.0 ships voice as a **scaffold**. Binaries + models are large platform-specific blobs — you install them once.

**To enable voice:**

1. Download whisper.cpp's `whisper-cli` binary + a GGML model → drop into `ARGOS_ROOT/tools/voice/whisper/`
2. Download a Kokoros binary + the Kokoro ONNX model + voices → drop into `ARGOS_ROOT/tools/voice/kokoro/`
3. Restart ARGOS. Launcher prints `[voice] whisper STT ready | kokoro TTS ready`.
4. In the chat surface: 🎤 mic icon appears in the composer; 🔊 speaker icon appears next to each assistant reply.

Full install paths + verification recipes in [`docs/VOICE.md`](docs/VOICE.md).

**Without voice installed:** the mic + play icons are simply hidden. Nothing breaks.

---

## 5. Settings

Click the gear (top-left) → Settings.

| Tab | What you can do |
|---|---|
| **Personas** | Pick default persona at boot. Saved to `config/settings.json`. Survives restart. |
| **Model** | Pick active model. Hardware probe shows GPU/CPU/Metal mode + recommendation. Manual override allowed. |
| **Vault** | List, delete documents. Stats: doc count + chunk count. |
| **About** | Build version, USB path, network status, runtime info. |

Any change is persisted atomically (temp-write + fsync + rename). Crash-safe against USB yank.

---

## 6. Stop

Close the launcher window (Windows) or `Ctrl-C` the terminal (mac / Linux). Both Next.js and Ollama shut down cleanly within ~3 seconds. The "Done." line confirms it.

**Then eject the drive normally** through your OS. Host machine is byte-for-byte identical to before plug-in. No registry writes. No leftover state.

---

## When something breaks

Common stuff, in order of likelihood:

| Symptom | Most likely cause | Fix |
|---|---|---|
| Browser opens but page is blank / 502 | Next.js still booting | wait 10s, refresh |
| "Bartimaeus: model not in Ollama store" in HUD | `e4b:latest` not installed | `ollama pull e4b:latest` (or `ollama list` to see what you have) |
| Vault search returns "no hits" + error in retrieval tail | `nomic-embed-text` missing | `ollama pull nomic-embed-text` |
| Persona radio greyed out with "Model not configured" | persona's bound model is missing from Ollama | install it, or pick a different persona |
| Chat returns empty assistant message but tokens were counted | gemma4-thinking-channel quirk; should be caught by `think:false` in `/api/chat` — if you see this, file an issue | n/a (handled in v1.0) |
| Both ports 11434 and 11435 in use | another Ollama instance is running | stop it, OR set `OLLAMA_HOST=127.0.0.1:11436` and start your own first |
| Both ports 7799 and 7800 in use | another Next.js or web app | free one of them |

For diagnostic depth: every action gets a tamper-evident audit entry. Query the chain:

```
curl http://127.0.0.1:7799/api/receipts?verify=1
```

Or run the standalone verifier (no framework deps needed):

```
node scripts/verify-audit-chain.mjs
```

See [`docs/AUDIT.md`](docs/AUDIT.md) for the full chain semantics.

---

## What ARGOS won't do

- Touch the host outside `ARGOS_ROOT/` (Rule #1, enforced by `npm run verify`)
- Make network calls beyond `127.0.0.1` (Rule #4, Rule #5)
- Write to the Windows registry / macOS preferences / Linux dotfiles
- Auto-update itself
- Phone home

The Seven USB-Native Rules are the contract. Every commit on `main` passes all 7. The audit chain is the receipt.

---

## Next reading (if you want it)

- [`README.md`](README.md) — project intro + verification toolbelt
- [`docs/05-OPERATIONS.md`](docs/05-OPERATIONS.md) — full operations runbook
- [`docs/06-V1.0-LOCKDOWN.md`](docs/06-V1.0-LOCKDOWN.md) — what ships in v1.0, what's deferred
- [`docs/00-DOCTRINE.md`](docs/00-DOCTRINE.md) → [`docs/04-THREAT-MODEL.md`](docs/04-THREAT-MODEL.md) — the architecture story
- [`docs/AUDIT.md`](docs/AUDIT.md) · [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md) · [`docs/VOICE.md`](docs/VOICE.md) — per-subsystem deep-dives
- [`methodology/decisions.md`](methodology/decisions.md) — every architectural decision with alternatives

---

That's it. Plug in. Type. Unplug. The host is identical to before.
