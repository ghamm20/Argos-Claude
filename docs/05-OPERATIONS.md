# Operations Runbook

Operator-facing recipes for routine tasks and common failure modes. Stays inside the doctrine — every action listed here respects the Seven Rules.

## Daily flow

### Start
```
Windows:  double-click ARGOS\launcher.bat from the USB drive
macOS:    right-click ARGOS/launcher.command → Open  (first launch only)
Linux:    ./launcher.sh from a terminal
```

Splash output shows:
- `ARGOS_ROOT` — where the app's state lives (your USB drive's ARGOS dir)
- `Next.js` — where the Next.js app dir is
- `Ollama` — which ollama binary the launcher resolved (bundled / system / PATH)
- `Logs` — where daemon logs are being captured

Browser opens to `http://127.0.0.1:7799` once Next.js is ready (~3 seconds on warm Ollama, ~10s cold).

### Stop
Press any key in the launcher cmd window (Windows) or `Ctrl-C` in the terminal (macOS/Linux). Both daemons (Next.js + Ollama) shut down cleanly within ~3 seconds. The launcher's cleanup path uses `netstat`-based PID lookup on Windows and TERM/KILL signals on Unix, so window-title drift (Next.js renaming its window) doesn't strand the daemon.

### Eject
After the launcher reports "Done.", eject the USB drive normally via OS. The drive can be re-inserted later and resume cleanly — no host-side state was created.

---

## Configuration

### Settings live in `ARGOS_ROOT/config/settings.json`

```json
{
  "version": 1,
  "defaultPersona": "bartimaeus",
  "defaultModel": "llama3.1:8b-instruct-q4_K_M",
  "updatedAt": 1779000000000
}
```

Change via Settings UI in the app, or edit the file directly when the app is stopped. The app reads on every settings page render — no restart needed.

Valid `defaultPersona`: `bartimaeus`, `juniper`, `cipher`.
Valid `defaultModel`: any in the on-disk Ollama models dir that the daemon can load. The UI lists them.

### Pointing at a different Ollama daemon

Set `OLLAMA_HOST` in the shell before launching:

```
Windows:  set OLLAMA_HOST=192.168.1.50:11434
          launcher.bat

macOS:    OLLAMA_HOST=192.168.1.50:11434 ./launcher.command

Linux:    OLLAMA_HOST=192.168.1.50:11434 ./launcher.sh
```

The launcher and the app both honor this env var via `lib/ollama-config.ts`. Defaults to `127.0.0.1:11434`.

### Pointing at a different models dir

Set `OLLAMA_MODELS`:

```
Windows:  set OLLAMA_MODELS=D:\my-other-models
```

The launcher only sets `OLLAMA_MODELS=%ARGOS_ROOT%\models` if the env var is unset. Caller-provided values win.

---

## Vault recipes

### Add documents
1. App → Vault tab → Drop file (or click "Choose file")
2. Supported: PDF, DOCX, MD, TXT
3. Max size: 50 MB per file (enforced in `app/api/vault/upload/route.ts`)
4. The vault stores extracted text + chunks + embeddings in `ARGOS_ROOT/vault/`

### Search the vault
- App → Vault tab → search box → type query
- OR via API: `POST /api/vault/search` with `{ "query": "...", "topK": 5 }`
- Returns ranked chunks. Topk capped at 50.

### Delete a document
- App → Vault tab → click trash icon next to doc
- OR API: `POST /api/vault/delete` with `{ "docId": "..." }`

### Vault state location
- Documents: `ARGOS_ROOT/vault/docs/` (extracted text)
- Index: `ARGOS_ROOT/vault/index/` (chunks + embeddings)
- Tmp uploads: `ARGOS_ROOT/tmp/` (cleaned up after ingest)

To wipe the vault completely: stop the app, delete `ARGOS_ROOT/vault/`, restart. The app recreates an empty vault on next ingest.

---

## Migration

### Initial USB migration (dev → USB)

```
npm run build
node scripts/migrate-to-usb.mjs --target=F:\ARGOS \
  --expect-label=PNY_PRO_ELITEV3 \
  --expect-drivetype=Removable
```

Pre-flight checks (Windows only via Get-Volume):
- Drive label matches `--expect-label` (refuses write if not)
- Drive type matches `--expect-drivetype` (Removable | Fixed)

What gets copied:
- `launchers/{bat,command,sh}` → drive root
- `bin/` ← entire `%LOCALAPPDATA%\Programs\Ollama\` tree (incl. `lib/ollama/*.dll`)
- `app/.next/` (production build, cache excluded)
- `app/node_modules/` (production deps only)
- `app/{package.json, package-lock.json, next.config.mjs, ...}`
- `models/` ← `~/.ollama/models/` (configurable via `--skip-models`)
- `vault/`, `logs/`, `tmp/`, `config/` (empty dirs)
- `docs/`, `methodology/` (audit trail)
- `README.txt` (generated quick-start)

Post-migration smoke: the script invokes `<target>/bin/ollama.exe --version` to confirm the binary copied + lib/ is intact.

### Re-running migration over an existing payload

Pass `--i-acknowledge-overwrite` to allow writing over an existing ARGOS dir. Without this flag, the script refuses if it sees `launcher.bat`, `app/.next`, or `models/manifests` already at the target.

### Migrating models only (no app re-copy)

There's no first-class flag for this. Use `robocopy` directly:

```powershell
robocopy "$env:USERPROFILE\.ollama\models" F:\ARGOS\models /MIR /MT:8
```

`/MIR` mirrors the source; `/MT:8` parallelizes. ~100× faster than the Node migration script for thousands of small blob files.

---

## Failure modes & recovery

### Launcher prints "Ollama did not respond within 30s"

Most likely causes:
1. Another process holds port 11434. Find + kill:
   ```
   netstat -ano | findstr ":11434"
   taskkill /F /PID <the_pid>
   ```
2. The ollama binary on the drive is missing `lib/` runtime DLLs. Verify:
   ```
   ls F:\ARGOS\bin\lib\ollama\*.dll
   ```
   Should show GGML, CUDA, and CPU-variant DLLs. If empty, re-run migration.
3. The launcher's `cmd /c` daemon spawn died on stdin. The launcher logs ollama stderr to `ARGOS_ROOT/logs/ollama.log` — read that for the real error.

### "ERROR: Input redirection is not supported" loop

This is a CI / non-interactive invocation issue, NOT a runtime issue when you double-click the launcher. The launcher uses `< NUL` to detach stdin precisely for this case. If you see this, your invocation context inherits a piped stdin that the `< NUL` should be neutralizing — check that you're running launcher.bat directly, not through some wrapper.

### F: shows as "Removable, 0 bytes, no filesystem"

NTFS corruption — often from yank-during-write. Recovery:
1. `chkdsk F: /F` to repair if possible
2. If unrepairable: `format F: /fs:NTFS /Q /V:PNY_PRO_ELITEV3 /Y` then re-migrate

The migration script's `--expect-label` pre-flight catches the more subtle "drive letter swapped between sessions" case before any write occurs.

### Drive letter changed between sessions

Windows reassigns letters on insert. Use `Get-Volume -DriveLetter X | Select FileSystemLabel` to verify identity before any large write. The migration script's `--expect-label=PNY_PRO_ELITEV3` flag bakes this check in.

### Build info shows wrong version

`lib/runtime-info.ts` reads `package.json` from `process.cwd()`. If the launcher was invoked from a context where cwd isn't the app dir, build info defaults to "argos-claude 0.0.0". Cosmetic only — fix by relaunching from the canonical path.

### Vault search returns no hits

Check the doc count: `GET /api/vault/list`. If 0, you haven't ingested anything. If non-zero but search returns 0 hits, the embedder might not be reachable — look for "Ollama not reachable" in the response body.

### Chat returns "model not found"

The default model isn't pulled. Either:
- Pull it: `ollama pull llama3.1:8b-instruct-q4_K_M`
- Switch model in Settings to one that IS pulled (the UI lists them)

---

## Verification toolbelt

| Command | What it does |
|---|---|
| `npm run check` | lint + typecheck + build + verify-argos (7 rules). Fast. |
| `npm run check:full` | check + dev-server smoke battery (h2, settings, vault, retrieval) |
| `node scripts/smoke-all-models.mjs` | Load + respond test for all 3 shipped models |
| `node scripts/smoke-input-validation.mjs` | 26 negative-test cases against API routes |
| `node scripts/smoke-vault-ranking.mjs` | Retrieval quality benchmark with known-answer queries |
| `node scripts/smoke-launcher-e2e.mjs` | Full launcher → first chat token timing (Windows only) |
| `node scripts/verify-host-clean.mjs --capture-before` | Snapshot host state before launcher run |
| `node scripts/verify-host-clean.mjs --capture-after` | Snapshot host state after launcher run |
| `node scripts/verify-host-clean.mjs --diff` | Compute attributable host writes from the diff |
| `npm run verify` | Just the Seven Rules harness (subset of check) |

---

## Logs

All daemon stderr lands in `ARGOS_ROOT/logs/`:
- `ollama.log` — Ollama daemon (port bind, GPU detect, model loads)
- `next.log` — Next.js production server (route hits, errors)
- `launcher.log` — launcher script's own diagnostic output (rarely used)

Logs are appended (no rotation). Delete files between sessions if they grow unwieldy — the launcher recreates them.

---

## Demo day pre-flight

Before walking into a demo:

1. Plug USB. Run `Get-Volume -DriveLetter F | Select FileSystemLabel, DriveType, Size, SizeRemaining` (substitute your drive letter) — confirm it matches expectations.
2. Double-click `launcher.bat`. Watch for the splash. Wait for browser to open.
3. Confirm chat works: send "hi" to the default persona. Should respond in <10s cold, sub-second warm.
4. Confirm vault works: upload a small markdown doc. Should ingest in <1s.
5. Confirm retrieval works: ask a question the doc answers. Citation pill should appear.
6. Close the launcher window. Confirm daemons stopped (`netstat -ano | findstr ":11434\|:7799"` → empty).
7. Eject drive. Plug into a guest machine. Repeat steps 2–5 to verify portability.

If any of those steps fail, see "Failure modes" above before showing it to anyone.
