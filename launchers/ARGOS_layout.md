# USB layout — target structure for H8 migration

This is the file/directory shape the launchers expect on the
shipped USB drive. H7 only documents it; H8 will migrate the
current repo state to match.

```
ARGOS/
├── launcher.bat               ← Windows entry point
├── launcher.command           ← macOS entry point (chmod +x)
├── launcher.sh                ← Linux entry point (chmod +x)
├── README.txt                 ← one-screen quick start (plain text)
│
├── bin/                       ← bundled binaries
│   ├── ollama.exe             ← Windows
│   ├── ollama-darwin          ← macOS universal
│   └── ollama-linux           ← Linux x86_64
│
├── app/                       ← production Next.js bundle
│   ├── .next/                 ← output of "npm run build"
│   ├── package.json           ← runtime metadata
│   ├── public/                ← static assets
│   └── node_modules/          ← production deps only (npm install --omit=dev)
│
├── models/                    ← Ollama model store (OLLAMA_MODELS env points here)
│   ├── manifests/             ← model index files
│   └── blobs/                 ← layer blobs
│
├── vault/                     ← user document store (ignored by git, created at first ingest)
│   ├── docs/                  ← original uploads
│   │   └── .tmp/              ← scratch during upload
│   └── index/
│       ├── manifest.json
│       └── chunks/            ← per-doc embeddings + text
│
├── config/                    ← per-user runtime settings (ignored by git)
│   └── settings.json          ← defaultPersona, defaultModel
│
├── logs/                      ← launcher + child process logs
│   ├── launcher.log
│   ├── ollama.log
│   └── next.log
│
├── tmp/                       ← scratch (TMPDIR env points here)
│
├── docs/                      ← read-only doctrine (shipped for reference)
│   ├── 00-DOCTRINE.md
│   ├── 01-SEVEN-RULES.md
│   ├── 02-SCOPE-LOCK.md
│   ├── 03-METHODOLOGY.md
│   └── 04-THREAT-MODEL.md
│
└── methodology/               ← thesis evidence (shipped for the audit trail)
    ├── README.md
    ├── gates.md
    ├── corrections.md
    ├── comparison-log.md
    ├── eyes-on-*.md
    └── sessions/              ← Claude Code transcripts (read-only)
```

## Path contracts the app already honors

These are already wired into the code (`lib/vault/paths.ts`,
`lib/settings.ts`, etc.) so migration is mostly a copy operation:

| App expectation | USB location |
|---|---|
| `argosRoot()` | `ARGOS/` |
| Vault docs dir | `ARGOS/vault/docs/` |
| Vault index dir | `ARGOS/vault/index/` |
| Settings file | `ARGOS/config/settings.json` |
| Logs (from launchers) | `ARGOS/logs/` |

The Next.js app reads `process.env.ARGOS_ROOT`; the launcher sets it
to the directory containing the launcher script.

## What changes vs current dev layout

| Concern | Dev (current) | USB (H8 target) |
|---|---|---|
| Launchers | `launchers/launcher.{bat,command,sh}` | `launcher.{bat,command,sh}` at root |
| Next.js code | repo root | `app/` subdir |
| node_modules | dev + prod | prod only (`--omit=dev`) |
| Ollama binary | system install on dev box | bundled in `bin/` |
| Models | `~/.ollama` on dev box | `models/` on USB (env-overridden) |
| .next | regenerated on dev | shipped pre-built |
| docs/methodology | tracked in git | shipped as static read-only assets |

## H8 migration plan (preview, do not execute here)

1. `mkdir ARGOS/app && cp -r .next package.json node_modules public ARGOS/app/`
2. `cp launchers/launcher.{bat,command,sh} ARGOS/`
3. Download Ollama platform binaries into `ARGOS/bin/`
4. Migrate Ollama model store: `ollama show --modelfile <model>` per
   model, then re-pull with `OLLAMA_MODELS=ARGOS/models ollama pull
   ...` to populate the bundled store. Verify identical SHAs.
5. Copy `docs/` and `methodology/` to `ARGOS/` (read-only assets).
6. Write `ARGOS/README.txt` quick-start.
7. Run a launcher from `ARGOS/` directly to validate the
   post-migration sniff path picks up `ARGOS/app/package.json`.
8. `dd` or `xcopy` the whole `ARGOS/` tree to the PNY drive root.
9. Host-diff verification: snapshot host filesystem before run,
   run launcher, snapshot after — confirm zero new files outside
   `ARGOS/` on the USB.

The launchers already support both layouts (dev + post-H8) via the
three-way sniff in step 1 of each script.

## Size budget (rough estimate)

| Component | Size |
|---|---|
| Next.js production build (.next + public + node_modules --omit=dev) | ~250–400 MB |
| Ollama binaries (3 platforms) | ~150 MB total |
| Models: nomic-embed-text 274 MB + qwen2.5:3b 1.9 GB + llama3.1:8b 4.9 GB | ~7.1 GB |
| Vault seed corpus + docs + methodology | <50 MB |
| **Total cold ship** | **~7.5–7.7 GB** |

Target USB: 16 GB PNY Friday (PNY's flash branding for "fast read"). The
ship payload uses under half the drive; the rest is user vault headroom.
