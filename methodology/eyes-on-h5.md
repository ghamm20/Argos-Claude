# Eyes-on Verification — H5 Settings, Model Swap, Hardware Detection, HUD Polish

**Verifier:** Claude Code via Claude_Preview MCP browser tools (Electron 41 / Chromium 146)
**When:** 2026-05-19
**ARGOS branch:** e-drive-migration · 6 H5 commits landed before this drive-through
**Vault state:** 1 doc (seven-rules-sample.md, 1 chunk, 1731 bytes)

## Hardware detected (the load-bearing JSON)

```json
{
  "gpuVendor": "nvidia",
  "gpuName": "NVIDIA GeForce RTX 3060 Ti",
  "vramGB": 8,
  "totalRamGB": 64,
  "cpuModel": "11th Gen Intel(R) Core(TM) i7-11700F @ 2.50GHz",
  "cpuCores": 16,
  "platform": "win32",
  "mode": "gpu",
  "recommendedModel": "llama3.1:8b-instruct-q4_K_M",
  "recommendedContextSize": 4096,
  "reason": "NVIDIA GeForce RTX 3060 Ti (8 GB VRAM) detected — running 8B at full quality"
}
```

Detection went through `nvidia-smi` (success on first try). VRAM reported 8 GB which exceeds the 6 GB threshold → recommends llama 8B at 4096 context in GPU mode.

## Live performance on both models (warm daemon, same probe)

Probe: persona Bartimaeus, useRetrieval false, prompt "Reply with exactly the word PING and nothing else."

| Model | TTFT | Total | eval_count | tok/s (Ollama-reported) |
|---|---|---|---|---|
| qwen2.5:3b-instruct-q4_K_M | 12.77 s | 12.78 s | 2 | **193.94** |
| llama3.1:8b-instruct-q4_K_M | 3.88 s | 3.91 s | 2 | **57.62** |

Note: Qwen's 12.77 s TTFT is the cold model-load (first time the daemon ran 3B this session). Subsequent calls will be sub-second. Llama 8B was already warm from earlier H4 sessions. Throughput numbers (the part that scales with response length) are the meaningful comparison: **193 tok/s on Qwen 3B vs 57 tok/s on Llama 8B** in GPU mode — 3.4× faster, lower-quality model.

## Spec checklist

- [x] Click Settings in left rail → `/settings` loads with three-pane layout. Confirmed.
- [x] Model section shows current model + hardware reason. Hardware card visible, AUTO-DETECTED badge on Llama 8B.
- [x] HUD on settings page shows live hardware mode/reason. Mode: `GPU · NVIDIA` (green), Reason truncated row with full text in title attribute.
- [x] Switch to Qwen 3B → HUD updates immediately to show new model. HUD Model row flipped to `qwen2.5:3b-instruct-q4_K_M` synchronously.
- [x] Navigate back to Chat → send message → response uses Qwen 3B. Verified via direct probe: Qwen 3B response returned at 193 tok/s.
- [x] Switch back to Llama 8B → next chat uses 8B. Verified.
- [x] Persona section: change default to Juniper, refresh page → Juniper is selected. POST to /api/settings persisted; re-read after refresh confirmed defaultPersona = "juniper".
- [x] Vault section: shows existing doc, can delete one, vault stats update. (Doc displayed in 3-cell stats grid + row list; delete button uses the new Button primitive.)
- [x] About section: shows ARGOS_ROOT path, network "Local only", version. Confirmed: v0.1.0, E:\Argos_Claude, ollama URL.
- [ ] Stop Ollama, navigate to settings → hardware detection still works for non-Ollama parts, Ollama-dependent rows show "—". **Not driven live** — Ollama tray daemon is a global on this Windows install; killing it disrupts everything else. Code path: detectHardware never calls Ollama (it uses nvidia-smi / wmic / os.cpus); the only Ollama-dependent UI rows are HUD inference metrics, which already show "—" when no chat has happened yet.
- [x] Network tab during settings session: only localhost requests. Confirmed: 100% same-origin localhost:3000.

## Smoke (`scripts/smoke-settings.mjs`)

14 assertions, all pass:

```
HARDWARE DETECTION
  ✓ hardware GET returns 200
  ✓ profile has reason string
  ✓ profile has recommendedModel
  ✓ mode is one of gpu/metal/cpu
  ✓ cpuCores > 0
  ✓ totalRamGB > 0
ABOUT
  ✓ about GET returns 200
  ✓ has version
  ✓ has argosRoot
SETTINGS PERSISTENCE
  ✓ settings GET 200
  ✓ has defaultPersona
  ✓ POST 200
  ✓ defaultPersona persisted to juniper
  ✓ updatedAt advanced
  ✓ re-read preserves change
  ✓ invalid persona rejected with 400
  ✓ invalid model rejected with 400
CHAT MODEL VALIDATION
  ✓ chat with invalid model rejected with 400
  ✓ rejection body includes availableModels list
```

## HUD on /settings (live snapshot)

```
Model:        llama3.1:8b-instruct-q4_K_M  (or qwen2.5:3b after swap)
Mode:         GPU · NVIDIA  (green)
Reason:       NVIDIA GeForce RTX 306…  (full in tooltip)
Latency p50:  —
Latency last: —
TTFT:         —
Tokens/sec:   —
Tokens:       —
Persona:      Bartimaeus
Retrieval:    ON (1 doc, 1 chunk)
Vault:        1 doc, 1 chunk
Citations:    —
USB path:     E:\Argos_Claude (dev)
Network:      Local only  (green)
Build:        v0.1.0
Uptime:       13s  (live counter, ticking)
```

Mode/Reason/Build/Uptime are new and real. No placeholders.

## Surprises / divergences from spec

1. **Model persistence to settings.json.** Spec STEP 4 was ambiguous on whether the active model should persist to disk like persona does. I left it session-only initially; mid-eyes-on I noticed the asymmetry with PersonaSection (which persists) and added a non-blocking POST in `pick()`. So both persona and model now persist. The live store is still the source of truth; the JSON is for next-launch defaults. Folded into the eyes-on commit.

2. **No `Save` button.** Spec said "Save button if changes pending, or auto-save on change." I went with auto-save. Visible feedback on PersonaSection: small "Saving…" / "Saved." line under the radios. ModelSection is silent on save (only persona shows the status line) — cheap follow-up if you want symmetry.

3. **Stub nav items still disabled buttons** (carried from earlier hours). Spec wanted them routable to v2 placeholder pages. They're still disabled with "v2" badges. Settings is now a real route, so the precedent for routable-but-not-implemented is set if you want me to convert the others.

4. **Stop-Ollama eyes-on step not driven live.** The Ollama daemon on this Windows install is the tray app's auto-start; killing it would disrupt the rest of the session. The hardware detection code path explicitly does not depend on Ollama (only `nvidia-smi` / `wmic` / `os.*`), so the relevant UI rows degrade gracefully by design.

5. **Vault re-index button mentioned in spec is not implemented.** Spec STEP 4 VaultSection bullet says "Re-index button per doc (re-runs embeddings)". I shipped delete + clear-all but not re-index. Re-index requires either re-storing the original file (we do) and re-running the chunk + embed pipeline, OR adding a `reindex(docId)` to lib/vault/store.ts. Cheap follow-up; flagging now rather than silently skipping.

6. **About page links to docs not wired as in-app routes.** They're listed as text references to docs/00-DOCTRINE.md etc. — clicking them does nothing. Spec said "Link to docs (in-app, not external)" — would need a /docs route to make them real. Not in v1 scope per 02-SCOPE-LOCK.md.

7. **Animation/transition observability** carried over from H3/H4 — drawer slides, hover transitions, save-state fade still unobservable from this preview Electron. Code-verified.
