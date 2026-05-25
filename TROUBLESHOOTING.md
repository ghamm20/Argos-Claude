# ARGOS Troubleshooting

When something is broken. Operator-facing diagnostic guide organized by symptom.

> If your symptom isn't here, check the audit chain — every action gets a tamper-evident receipt:
>
> ```
> curl http://127.0.0.1:7799/api/receipts?verify=1 | jq .verify
> ```
>
> A passing `verify.ok = true` rules out chain corruption. The latest few `entries[]` show what's been happening on the system.

---

## Boot problems

### Launcher window opens then closes immediately

The launcher is hitting a fatal error before the daemons start. Likely causes:

1. **Both Ollama ports already in use** — `netstat -ano | findstr 11434` (Windows) or `lsof -i :11434` (mac/linux). Free one of `11434` / `11435` and re-run.
2. **Both Next.js ports in use** — same diagnostic with `7799` / `7800`.
3. **Ollama binary not found** — launcher looks at `ARGOS_ROOT/bin/ollama.exe` → `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` → `PATH`. Verify with `where ollama` (Windows) / `which ollama` (Unix).
4. **`ARGOS_ROOT/logs/launcher.log`** captures errors. `Get-Content $env:ARGOS_ROOT\logs\launcher.log -Tail 20` shows the most recent.

### "Ollama did not respond within 30s"

The launcher started Ollama but `curl http://127.0.0.1:11434/api/tags` never succeeded.

1. Read `ARGOS_ROOT/logs/ollama.log` — daemon stderr is captured there.
2. Common cause on Windows: missing `lib/` runtime DLLs. Run `<ARGOS_ROOT>\bin\ollama.exe --version` directly to confirm the binary loads. If it errors about missing DLLs, the bundled tree is incomplete; re-run `migrate-to-usb.mjs`.
3. On mac: Gatekeeper may be blocking the binary. `xattr -dr com.apple.quarantine <ARGOS_ROOT>/bin/ollama`.

### Browser opens to blank page / 502

Next.js still booting. Wait 10s and refresh. If the 502 persists:

1. `Get-Content $env:ARGOS_ROOT\logs\next.log -Tail 30` — Next.js stderr.
2. Most common: a `.next` directory mismatch (built on different Node version, etc.). Rebuild via `npm run build` from the source repo and re-mirror.

---

## Chat / persona problems

### "Bartimaeus: model not in Ollama store" in HUD Status

The persona's bound model isn't installed in your current Ollama. Fix:

```
ollama list                   # see what's actually installed
ollama pull e4b:latest        # or whatever the persona expects
```

After install, restart ARGOS OR open Settings → Personas → re-pick Bartimaeus to retry the warm-load.

### Chat assistant returns empty response

Two known causes:

1. **Thinking-channel issue** — if you're on a gemma3+/gemma4/qwen3+ model and `think:false` isn't being passed, all content goes to `message.thinking` and `message.content` is empty. v1.0+ sets `think:false` globally in `/api/chat`. If you see this in v1.0+, it's a regression — check `app/api/chat/route.ts` for the `think: false` line.
2. **Ollama crashed mid-stream** — check `logs/ollama.log`. Common on cold-start when VRAM is tight (e4b uses 91% of 8GB).

### Persona radio greyed out with amber "Model not configured" pill

The persona has `status: "not_configured"` because its bound model isn't installed. The pill shows the `intendedModel` and install instructions inline. Two options:

1. Install the intended model: `ollama pull <intendedModel>`. After install, edit `lib/personas.ts` to set `status: "selectable"` and re-bind the `model` field. Restart ARGOS.
2. Re-bind the persona to a model you do have installed. Edit `lib/personas.ts`, set `status: "selectable"` and `model: "e4b:latest"` (or whichever). The persona keeps its system prompt and voice; only the backend changes.

### Chat reply is on-character but feels less sharp than usual

Likely cause: **persona is running on a smaller-than-intended model** (e.g. Juniper on `gemma2-2b-local:latest` stopgap vs the intended `Qwen3.5-9B`). Check `lib/personas.ts` — if `intendedModel` differs from `model`, you're on a stopgap.

### HUD shows "Loading <persona>…" for >30s

The model warm-load is taking longer than expected. Possible causes:

1. **Cold disk load on slow USB.** A 5 GB model from USB 2.0 can take 30-60s on first load. After first load, Ollama caches in RAM; subsequent loads are fast.
2. **VRAM pressure forcing a CPU offload.** Check `nvidia-smi` while it's loading. If memory.used approaches memory.total, Ollama may be juggling layers between GPU and CPU — slow.
3. **Ollama daemon hung.** Restart Ollama: kill the `ollama.exe` window, re-launch ARGOS.

If it ultimately fails: HUD shows "Failed" with the error message. The operator can pick a different persona or fix the underlying issue.

---

## Vault / retrieval problems

### Vault search returns no hits even though documents are ingested

1. **`nomic-embed-text` not installed.** `curl http://127.0.0.1:7799/api/chat -X POST ...` and check the retrieval tail event — if `error` mentions `nomic-embed-text`, run `ollama pull nomic-embed-text`.
2. **All hits below the confidence floor.** Per-persona policy (`lib/personas.ts`): Bart=medium (≥0.40), Sage=low (≥0.25). If your query is far from your vault content, all hits filter out. Try a more on-topic query, OR temporarily lower the floor in persona config.
3. **Vault is actually empty for your persona's policy.** Check `curl http://127.0.0.1:7799/api/vault/list` — should show docs + totalChunks.

### Auto-ingest doesn't pick up files dropped in `vault/dropbox/`

1. The launcher fires auto-ingest only once at boot. To trigger mid-session: `curl -X POST http://127.0.0.1:7799/api/vault/auto-ingest`.
2. Check `vault/dropbox/.errored/` — files that failed ingest end up there with a sibling `.error.txt` explaining why (unsupported format, parse error, etc.).
3. Supported types: `.pdf` `.docx` `.md` `.txt`. Anything else is ignored, not errored.

### Document ingest fails with "file too large"

50 MB hard cap per file (enforced in `app/api/vault/upload/route.ts`). Split the document or use a different format.

### Retrieval injects irrelevant hits ("garbage in citations")

Tighten the per-persona minConfidence in `lib/personas.ts`. Bart's `medium` floor is the conservative default. If even that's noisy, bump Bart to `high` (≥0.55). Trade-off: fewer false positives but more "I don't have anything relevant" responses.

---

## Voice problems

### Mic / play buttons don't appear in the UI

Voice binaries aren't installed. The capability probe (`GET /api/voice/status`) returns `available: false` so the buttons hide. To enable:

```
# Install paths (see docs/VOICE.md for full details):
ARGOS_ROOT/tools/voice/whisper/whisper-cli(.exe)
ARGOS_ROOT/tools/voice/whisper/models/ggml-base.en.bin
ARGOS_ROOT/tools/voice/kokoro/kokoros(.exe)
ARGOS_ROOT/tools/voice/kokoro/models/kokoro-v1.0.onnx
ARGOS_ROOT/tools/voice/kokoro/models/voices-v1.0.bin
```

After install, restart ARGOS. Launcher prints `[voice] whisper STT ready | kokoro TTS ready`. UI re-probes on mount; refresh the browser.

### Mic clicks record but transcribed text never appears

1. **Browser denied mic permission.** Check site permissions in your browser settings; allow microphone for `http://127.0.0.1:7799`.
2. **whisper-cli timed out** — `POST /api/voice/stt` has a 120 s hard cap. If your recording is longer than ~60 s on slow hardware, the model may not finish. MicButton has a 60 s recording cap; check that it's enforced.
3. **Audio decode failed in browser** — the `OfflineAudioContext` resampler can fail on unusual codecs. Open browser console; look for `decodeAudioData` errors.

### TTS speaker icon spins forever

1. **kokoros binary crashed** — check `state/voice/cache/` for partial output, and review the server console / next.log for the spawn exit code.
2. **Kokoros fork uses different CLI flags than `lib/voice.ts` expects.** v1.0 expects long-form flags (`--model`, `--voices`, `--text`, `--voice`, `--output`). If your fork uses short flags, edit `synthesizeText()` in `lib/voice.ts` to match.
3. **Voice argument invalid** — `af_bella` is the default. Some forks reject voice names that aren't in their voices.bin manifest. Try removing the `--voice` argument or using a known-good name.

---

## Audit / receipts problems

### `/api/receipts?verify=1` returns `verify.ok = false`

The chain has been tampered with OR there's a structural break. The `brokenReason` field names what happened + at which `brokenAtIndex`. Possible causes:

1. **Manual edit to `state/audit/chain.jsonl`.** Chain is intentionally tamper-evident; manual edits break the hash chain. The verifier flags the index where verification failed.
2. **Truncated mid-write** (e.g. USB yanked during append). The truncated line at the tail is flagged as invalid JSON; delete it, the chain remains valid from genesis to last clean line.
3. **Hash-recompute failure** — the entry's stored `hash` doesn't match `sha256(prevHash + ":" + canonical(entry minus hash))`. Most likely a payload tamper.

Don't "fix" a broken chain by editing entries — that's exactly what the tamper-detection caught. Either accept the break (chain restarts from genesis on next append; receipts show the gap forever) OR roll back to a known-good chain.jsonl from backup.

### Standalone verifier disagrees with `/api/receipts?verify=1`

Both run the SAME algorithm (`scripts/verify-audit-chain.mjs` is the reference implementation; `verifyChain()` in `lib/audit.ts` is the in-process equivalent). If they disagree, either:

1. They're looking at different chain files (server reads from `process.env.ARGOS_ROOT/state/audit/chain.jsonl`; verifier defaults to the same but accepts `--chain PATH`).
2. The chain was modified between the two reads. Re-run both and compare.

### Bundle export `bundleHash` doesn't match recompute

The bundle export uses the same canonical-JSON serialization as the chain. If the bundle's `bundleHash` doesn't recompute, the bundle was tampered with after export. The export endpoint at `app/api/chat/sessions/[id]/export/route.ts` is the reference; recompute via:

```
node -e "
const c = require('crypto');
const fs = require('fs');
const b = JSON.parse(fs.readFileSync('your-bundle.json'));
const { bundleHash, ...rest } = b;
// implement canonicalJson per docs/AUDIT.md
console.log(c.createHash('sha256').update(canonicalJson(rest)).digest('hex'));
console.log('stored:', bundleHash);
"
```

---

## Launcher / state problems

### Settings tab shows wrong default persona / model after restart

`config/settings.json` is the source of truth. Check the file directly:

```
cat $ARGOS_ROOT/config/settings.json
```

Should match what HUD shows. If they differ:

1. **Browser cached state from a previous session.** Hard-refresh (Ctrl+Shift+R / Cmd+Shift+R).
2. **`ChatPane` hydration didn't fire.** Open DevTools → Network tab; verify `/api/settings` returned 200 with the expected `defaultPersona`.
3. **Settings file is corrupted.** Delete it; ARGOS rebuilds with safe defaults (bartimaeus + e4b:latest).

### Logs growing unbounded

Rotation kicks in at 10 MB per log, keeping 3 generations (`.1` `.2` `.3`). If your `launcher.log` is >10 MB and there are no `.1`/`.2`/`.3` siblings, the rotation may not be firing — confirm the launcher's `:ROTATE_LOG` subroutine was called.

### USB yank mid-write left a `.tmp` file in `config/`

Atomic-write pattern: ARGOS writes to `settings.json.<pid>.tmp` first, then renames. If killed between write and rename, the temp file is orphaned but `settings.json` is still the previous valid version. Safe to delete any `.tmp` file you find in `config/`.

---

## Build / verify problems (developer-side)

### `npm run verify` Rule 1 fails: "no hardcoded absolute paths"

You added a `C:\...` or `/Users/...` literal to source. Replace with a path computed from `process.env.ARGOS_ROOT` or one of the helpers in `lib/vault/paths.ts`.

### Rule 5 fails: "storage paths derive from ARGOS_ROOT"

An `fs.writeFile` / `fs.appendFile` / etc. has a literal absolute path. Same fix as Rule 1.

### Rule 6 / 7 fails: launcher daemon spawns

You added a daemon-spawn line to a launcher without log redirect (`>>` `2>&1`) or — Windows only — without `< NUL` inside the `cmd /c "..."` wrapper. See `scripts/verify-argos.mjs` for the exact regex; the existing OLLAMA/NEXT spawn lines are the reference pattern.

### Build passes but `next start` fails with a hydration error

The `.next` directory was built on a different Node version than what's installed locally. Rebuild via `npm run build` from the source repo with the local Node.

---

## When all else fails

1. **Read the audit chain** — `state/audit/chain.jsonl`. Every event has a structured payload + timestamp. The line just before the failure usually points at what happened.
2. **Restart everything** — close launcher (clean shutdown), wait 5s, re-launch.
3. **Run the e2e smoke** — `node scripts/smoke-v1-e2e.mjs` (against a built source repo, not the deployed payload). 23 checks across boot, model warm, chat, audit, export, verifier. If any FAIL, the failure name tells you which surface is broken.
4. **Validation harness** — `node scripts/validate-e4b.mjs` measures cold load, warm TTFT, tok/s, VRAM, coherence on prompts A-E. Detects degenerate-token output. If it FAILs, your model install is suspect.
5. **Integrity check** — `npm run integrity:hash` re-verifies model blob sha256s against `models.json` if you have one. Catches bit-rot on the Ollama models dir.

---

## When to file a bug

If you've exhausted this guide AND `npm run verify` 7/7 PASSes AND the audit chain verifies AND the e2e smoke passes, but ARGOS still misbehaves, that's a genuine bug. Capture:

- The audit chain entries around the failure (last 20-50 entries)
- `logs/next.log` tail
- `logs/ollama.log` tail
- The exact reproduction steps
- ARGOS commit SHA (`git rev-parse HEAD` if you have the source)

---

## See also

- [`OPERATOR_QUICKSTART.md`](OPERATOR_QUICKSTART.md) — single-page boot-to-stop happy path
- [`docs/05-OPERATIONS.md`](docs/05-OPERATIONS.md) — operations runbook (daily flow, config, vault, migration)
- [`docs/06-V1.0-LOCKDOWN.md`](docs/06-V1.0-LOCKDOWN.md) — what's in v1.0, what's deferred
- [`docs/AUDIT.md`](docs/AUDIT.md) — audit chain semantics
- [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md) — vault retrieval architecture
- [`docs/VOICE.md`](docs/VOICE.md) — Whisper + Kokoro install
