# ARGOS

USB-native local AI workstation. Runs entirely from removable media — zero host install footprint, zero registry writes, zero cloud calls.

Plug in. Launch. Use. Unplug. Host machine is byte-for-byte identical to its pre-plug state.

## What it is

- **Next.js 14** App Router + TypeScript + Tailwind v3 (shadcn primitives, Radix UI)
- **Local LLM** via Ollama daemon on `127.0.0.1:11434` (with `:11435` fallback), models served from the USB drive
- **Four personas** — Bartimaeus (live default, strategist), Sage (research), Bobby (plain-talk), Juniper (warm) — each with its own system prompt, eye color, and bound model
- **Vault** — drag-drop or drop into `vault/dropbox/` (PDF / DOCX / MD / TXT) → chunked → embedded via `nomic-embed-text` → in-memory cosine retrieval; per-persona policy + 3-bucket confidence (HIGH / MED / LOW)
- **Truth Mode** — toggle that injects citation enforcement into the persona prompt and renders citation pills in the chat surface
- **Hash-chained audit log** — every session / vault / settings change is appended to `state/audit/chain.jsonl` with sha256 chaining; standalone verifier ships in `scripts/verify-audit-chain.mjs`
- **JSON bundle export** — tamper-evident session bundles with `bundleHash` over canonical JSON
- **Voice scaffold** — Whisper STT + Kokoro TTS API + UI; binaries operator-supplied per `docs/VOICE.md` (UI hides controls when missing)
- **Tools dock** — health-checks external tools (Oculus / SuperAGI) declared in `tools/registry.json`
- **Settings** — hardware detection, model swap, persona default, vault stats, build info — all server-rendered, all backed by `config/settings.json` on the drive (atomic write)
- **Cross-platform launcher** — `.bat` / `.command` / `.sh` with port fallback, 10 MB log rotation, tool-boot block, voice presence probe

## Quick start

### From the USB drive (production)

```
Windows: double-click ARGOS\launcher.bat
macOS:   right-click ARGOS/launcher.command -> Open  (first launch only, Gatekeeper)
Linux:   ./launcher.sh from a terminal
```

The launcher starts Ollama on `127.0.0.1:11434`, Next.js production server on `127.0.0.1:7799`, and opens your default browser. Closing the launcher window triggers clean shutdown.

### From source (development)

```
npm install
npm run dev               # next dev on :3000
# in another shell:
npm run check             # lint + typecheck + build + verify-argos (7 rules)
npm run check:full        # check + dev-server smoke battery (h2/vault/retrieval/settings)
```

## Operator quickstart

If you just plugged in the drive and want the shortest path to "ARGOS is doing something useful", read [`OPERATOR_QUICKSTART.md`](OPERATOR_QUICKSTART.md). Single page. Boot → first chat → vault drop → optional voice install → stop. Everything else in this README is for developers.

## Doctrine

The project is bound by a set of architectural hard rules. Read these in order:

- [`docs/00-DOCTRINE.md`](docs/00-DOCTRINE.md) — what ARGOS is and isn't
- [`docs/01-SEVEN-RULES.md`](docs/01-SEVEN-RULES.md) — Seven USB-Native Rules (zero host writes, zero registry writes, relative paths only, scoped env vars, etc.)
- [`docs/02-SCOPE-LOCK.md`](docs/02-SCOPE-LOCK.md) — v1.0 scope envelope (current + historical original)
- [`docs/03-METHODOLOGY.md`](docs/03-METHODOLOGY.md) — thesis framing
- [`docs/04-THREAT-MODEL.md`](docs/04-THREAT-MODEL.md) — security posture
- [`docs/05-OPERATIONS.md`](docs/05-OPERATIONS.md) — daily operations runbook
- [`docs/06-V1.0-LOCKDOWN.md`](docs/06-V1.0-LOCKDOWN.md) — what ships in v1.0, what's deferred, acceptance checklist

Per-subsystem deep-dives:
- [`docs/AUDIT.md`](docs/AUDIT.md) — hash-chained audit log + tamper-evident bundles
- [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md) — vault retrieval architecture + confidence buckets
- [`docs/VOICE.md`](docs/VOICE.md) — Whisper STT + Kokoro TTS install + architecture

## Verification

`npm run verify` (also part of `npm run check`) runs the executable form of the Seven Rules harness:

```
[PASS] Rule 1: no hardcoded absolute paths (C:\, D:\, /Users/, /home/, /mnt/, /tmp/, /var/)
[PASS] Rule 2: no network / analytics packages in runtime dependencies
[PASS] Rule 3: filesystem path operations use path.join (no manual slash concat)
[PASS] Rule 4: no external CDN imports / remote fetch in source (localhost OK)
[PASS] Rule 5: storage paths derive from ARGOS_ROOT (no hardcoded absolute roots in fs writes)
[PASS] Rule 6: launcher daemon spawns must redirect stderr to a log file
[PASS] Rule 7: Windows launcher cmd /c daemon spawns must use `< NUL` to detach stdin
```

CI (`.github/workflows/ci.yml`) runs the same harness plus the static smoke battery on every push to main and every PR.

For end-to-end verification including the dev-server smokes:

```
npm run check:full
```

## Migration to USB

```
npm run build                                       # produce .next/
node scripts/migrate-to-usb.mjs --target=F:\ARGOS \
  --expect-label=PNY_PRO_ELITEV3 \
  --expect-drivetype=Removable
```

The script copies the production build, all runtime dependencies, the full Ollama install tree (incl. lib/ runtime DLLs), and your Ollama models to the target drive. The `--expect-label` pre-flight is a Windows-only Get-Volume check that refuses to write to a drive that doesn't match — defensive against drive-letter reassignment.

See [`launchers/ARGOS_layout.md`](launchers/ARGOS_layout.md) for the on-disk layout.

## Methodology

`methodology/` is the audit trail. Notable entries:

- [`methodology/eyes-on-h8.md`](methodology/eyes-on-h8.md) — H8 USB migration verification, real launcher e2e timings
- [`methodology/corrections.md`](methodology/corrections.md) — human-in-the-loop corrections and AI self-corrections (the thesis evidence)

## License

Not yet declared. If you're reading this from a public repo before a LICENSE file has landed, treat it as all-rights-reserved by default.

## Author

Built in a 14+ hour single-session sprint by Gordy (operator) and Claude (Sonnet 4.5 + Opus 4.7, both via Anthropic's Claude Code CLI). The full session transcript and methodology are part of the audit trail under `methodology/`.
