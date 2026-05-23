# ARGOS launchers — design doc

Three platform-specific launcher scripts that make ARGOS plug-and-play
from removable media. Double-clicking a launcher on its host OS must
take you from "USB plugged in" to "ARGOS chat ready in browser" inside
the cold-start budget below, and yanking the USB or closing the
launcher must clean up every process with zero host artifacts.

## Files

| Platform | Script | How user invokes |
|---|---|---|
| Windows | `launcher.bat` | Double-click in Explorer |
| macOS | `launcher.command` | Double-click in Finder (first time: right-click → Open to bypass Gatekeeper) |
| Linux | `launcher.sh` | Double-click in file manager (if executable) or `./launcher.sh` from terminal |

All three set the same environment, manage the same two child
processes (Ollama + Next.js), and have the same stage splash.

## ARGOS_ROOT resolution

Each script sniffs three layouts so it works pre-migration (dev) and
post-migration (USB):

1. `$SCRIPT_DIR/app/package.json` exists → ARGOS_ROOT = `$SCRIPT_DIR`,
   Next.js dir = `$SCRIPT_DIR/app` (the **post-H8 USB layout**)
2. `$SCRIPT_DIR/package.json` exists → ARGOS_ROOT = `$SCRIPT_DIR`,
   Next.js dir = `$SCRIPT_DIR` (rare; launcher at repo root)
3. `$SCRIPT_DIR/../package.json` exists → ARGOS_ROOT = parent of
   `$SCRIPT_DIR`, Next.js dir = parent (the **pre-H8 dev layout**
   where launchers live in `launchers/` subdir of the repo)
4. Otherwise → exit 1 with "could not locate ARGOS app"

Same script works in both layouts. H8 will move launchers to USB
root and the Next.js bundle into `app/`; until then they're under
`launchers/` for dev convenience.

## Environment (child processes only — Seven Rules #4)

These are exported in the launcher process and inherited by Ollama
and Next.js. They never touch the user shell's persistent env.

| Var | Value | Purpose |
|---|---|---|
| `ARGOS_ROOT` | resolved per above | path.join base used throughout the app |
| `NEXT_TELEMETRY_DISABLED` | `1` | Rule 5 — no network beacons |
| `OLLAMA_MODELS` | `$ARGOS_ROOT/models` | model blobs live on the drive, not in `~/.ollama` |
| `TMPDIR` | `$ARGOS_ROOT/tmp` | scratch space stays on the drive |

## Ports

| Service | Primary | Fallback | Why |
|---|---|---|---|
| Ollama daemon | 11434 | 11435 | Ollama's default; fallback added Phase 1 (v1.0) |
| Next.js (prod) | 7799 | 7800 | Distinct from dev port (3000); fallback added Phase 1 (v1.0) |

Port collision handling (Phase 1, v1.0): each launcher pre-flights
both primary ports via a `LISTENING`-state check (Windows `netstat`,
Unix bash `/dev/tcp`) BEFORE starting daemons. If the primary is
busy, it falls back to the secondary and continues. If BOTH are
busy, it exits with a clear error rather than the prior 30-second
silent wait.

The chosen ports are echoed in the splash (`Ports  Ollama X  Next.js Y`)
and used everywhere downstream — curl polls, browser-open URL, and
cleanup. The browser-open uses the fallback URL automatically.

A caller-set `OLLAMA_HOST` (smoke harnesses, devs pointing at a
remote daemon) is honored verbatim — the launcher skips its own
Ollama-side fallback in that case and parses the port out of
`OLLAMA_HOST` for the curl-poll. Skipping the daemon start when
`OLLAMA_HOST` points to a remote is a v2 concern (clients today
still spawn a local daemon in that case; harmless if the local
port is free).

## Process management

Each launcher:
1. Records the child PIDs (Unix: `$!` capture; Windows: distinct
   window titles so `taskkill /FI "WINDOWTITLE eq …"` can find
   them).
2. Installs a cleanup handler (Unix: `trap` on INT/TERM/EXIT;
   Windows: a `:CLEANUP` label that runs on normal exit).
3. On cleanup: send graceful signal first (SIGTERM / taskkill
   without /F), wait one second, then force-kill if still alive.

## Splash output

Four stages, each printed before the work that follows it. The
resolved ports (primary or fallback) substitute in:

```
[1/4] Starting Ollama on 127.0.0.1:11434...
   ... waiting (1/30)
   ... waiting (2/30)
[2/4] Ollama ready on port 11434
[3/4] Starting Next.js on 127.0.0.1:7799...
   ... waiting (1/30)
[4/4] ARGOS ready — opening browser at http://127.0.0.1:7799
```

If a fallback fires, the splash also includes an `[INFO]` line
above stage 1:

```
[INFO] Port 11434 in use; falling back to 11435.
```

No fake progress bar. The `… waiting (N/30)` counter is real — each
tick is a real curl poll against the service.

## Log rotation (Phase 1, v1.0)

The launcher rotates `logs/launcher.log`, `logs/ollama.log`, and
`logs/next.log` BEFORE spawning daemons if any has exceeded **10 MB**.
Rotation keeps 3 generations: `.1` (most recent prior), `.2`, `.3`
(oldest). Anything beyond `.3` is deleted. The current log is renamed
to `.1` and a fresh one is created when the daemon writes.

Done pre-spawn so the rename can succeed — Windows holds an exclusive
write handle on the log file while Ollama / Next.js are running.

## Cold-start budget

| Hardware | Budget | What the budget covers |
|---|---|---|
| Gaming PC, RTX 3060 Ti, 64 GB RAM, NVMe | ~15 s | model already warm in `~/.ollama` |
| ThinkPad Ryzen 7, integrated AMD GPU, 16 GB RAM, SATA SSD | **45 s worst case** | first-call model load is the dominant cost |

The 45-second number is the design ceiling, not the typical. The
stage splash exists so the user knows the launcher is working during
the wait.

## Clean-shutdown contract

When the user closes the launcher window (preferred: type any key at
the "shut down" prompt; less preferred: X-close the window):

1. Send TERM to the Next.js child. Wait 1s.
2. Send TERM to the Ollama child. Wait 1s.
3. Force kill anything still alive.
4. Flush vault writes (Next.js already does this on graceful
   shutdown via its own SIGTERM handler).
5. Total shutdown budget: 3 seconds (Seven Rules #6 — graceful
   eject).

X-closing the cmd window on Windows skips the cleanup label and
orphans the child windows. Both child daemons run with a visible
minimized window so the user can manually close them if X-close
happens. Documented as known cost — type-key-then-pause is the
graceful path.

## Acceptance criteria

The launcher "works" when **all five** of these hold on the target
hardware:

1. **Double-click → browser open within 45 s.** Cold path, model
   already on disk, daemon not running.
2. **Close → both PIDs terminate.** `tasklist` (Windows) or `ps`
   (Unix) shows no orphaned Ollama or node processes within 3 s of
   user closing the launcher window.
3. **Host filesystem diff is empty.** Compare `dir /S` snapshot of
   the user home + AppData before and after launcher run. Zero new
   files (vault and config writes land on the USB, not the host).
4. **Re-launch works immediately.** Second double-click within five
   seconds of the first close → ports clean, services come up, no
   stale state.
5. **USB yank during run → graceful error.** Pulling the drive
   mid-conversation produces a visible error in the chat UI and no
   host artifacts. Next.js may exit; that is acceptable as long as
   the host stays clean.

The smoke script `scripts/smoke-launcher.mjs` enforces the
file-level subset of these (script existence, perms, structure
markers). The full acceptance set requires manual eyes-on per the
methodology, captured in `methodology/eyes-on-h7.md`.

## Platform gotchas

### Windows
- `curl` ships with Windows 10+ (since 2017) so no extra install
  needed. Older Windows: launcher will exit with a friendly error
  in stage 1 because the poll fails.
- Windows Defender may briefly quarantine a freshly-extracted
  launcher.bat. If quarantined, right-click → Properties → Unblock.
  Documented behavior, not a bug — happens because the file came
  from an "internet zone" mark when downloaded.
- X-closing the launcher cmd window orphans children. Use the
  "press any key to shut down" prompt for graceful exit.

### macOS
- First launch: macOS Gatekeeper rejects `.command` files from
  unverified developers. Right-click → Open the **first time** to
  bypass. Subsequent launches work normally.
- The terminal window stays open during the session — this is
  intentional, it hosts the cleanup trap.

### Linux
- Headless boxes (no `$DISPLAY`): the launcher prints the URL and
  the user opens it from another machine. `xdg-open` is skipped.
- Distros without `xdg-open` (rare): the launcher prints the URL
  and continues — services still come up.
