# Eyes-on Verification — H7 Cross-platform launcher

**Verifier:** Claude Code on Windows 11 (DESKTOP-99O9E03, i7-11700F + RTX 3060 Ti)
**When:** 2026-05-19
**Branch:** e-drive-migration · 8 H7 commits landed (1 cleanup, 7 launcher work)
**Platform driven live:** Windows only. macOS .command + Linux .sh code-verified and smoke-passed; cannot e2e from this box.

## Cleanup from H6 score-harness flags

| Flag | Resolution | Commit |
|---|---|---|
| `/api/about` out-of-scope | Removed route, created `lib/runtime-info.ts` for server-side build/version info, threaded as props through 6 server pages and 2 components | `a2ce048` |
| 2 dirty files (`ARGOS/`, `argos imagery.png`) | Documented as user-supplied reference material, decision recorded in `methodology/corrections.md` | folded into `a2ce048` |

`npm run check` green post-cleanup (lint + typecheck + build + verify), 5 dynamic routes (down from 6), 4 static stub routes.

## Smoke (`scripts/smoke-launcher.mjs`)

41 checks across all three launchers + README + layout doc. **All green.**

```
=== Windows (launcher.bat) ===  9/9
=== macOS  (launcher.command) === 11/11  (incl. git index mode 100755)
=== Linux  (launcher.sh)      === 12/12  (incl. headless DISPLAY fallback)
=== README ===                    5/5
=== Layout doc ===                5/5
```

## Live e2e (Windows only)

Captured a clean cold-to-ready cycle of launcher.bat after fixing three real bugs the file-level smoke could not have caught:

| Stage | Output |
|---|---|
| Header | `ARGOS_ROOT  E:\Argos_Claude` / `Next.js  E:\Argos_Claude` / `Ollama  C:\Users\Gordy\AppData\Local\Programs\Ollama\ollama.exe` |
| [1/4] | `Starting Ollama on 127.0.0.1:11434...` |
| [2/4] | `Ollama ready on port 11434` (warm — tray daemon was already serving) |
| [3/4] | `Starting Next.js on 127.0.0.1:7799...` |
| [4/4] | `ARGOS ready - opening browser at http://127.0.0.1:7799` |
| Probe | `GET http://127.0.0.1:7799 → 200`, 27 381 bytes |
| Chat smoke | `POST /api/chat` against the launcher-managed prod server returned a full NDJSON stream with `eval_count`, `eval_duration`, retrieval event, `done:true`. |
| Cleanup probe | Ran the launcher's CLEANUP label code directly: `for /f "tokens=5" %P in ('netstat -ano \| findstr ":7799" \| findstr "LISTENING"') do taskkill /F /PID %P` → killed PID 8296, port freed, Ollama tray daemon survived (still `200 OK` on `:11434`). |

**Cold-start time observed:** the wait-loop's polling granularity was 1s and Ollama was already warm, so the splash showed essentially no wait time. The genuine cold-start measurement requires a from-scratch run (no daemon running, no model in RAM) on the ThinkPad target — that is the H8 USB-drive run, not this dev-box test.

## Three real bugs caught during eyes-on, fixed before final commit

The smoke script could not have found these — they only surface when cmd actually parses + runs the file. Each was a real broken state that would have shipped if I had stopped at file-level smoke.

1. **Layout sniff always failed.** cmd's `if exist` does not resolve `..\` mid-path. Fixed by canonicalising the parent dir via `for %%I in ("%SCRIPT_DIR%\..") do set "PARENT_DIR=%%~fI"` BEFORE the if-chain, then testing `if exist "%PARENT_DIR%\package.json"`.

2. **Parens inside echo lines of an `else (…)` block broke parsing.** The error-message echoes contained text like `(post-H8 USB layout)`; cmd's paren-counting closed the else block early and treated subsequent lines as commands. Fixed by escaping every `(` and `)` inside echoed text as `^(` and `^)`. Three echo lines affected.

3. **Next.js renames its cmd-window title from `ARGOS-NEXT` to `next-server (vX.Y.Z)` once the server is up.** The launcher's `taskkill /FI "WINDOWTITLE eq ARGOS-NEXT*"` therefore missed it on every shutdown. Fixed by replacing the title-match with a netstat lookup: `for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":7799" ^| findstr "LISTENING"') do taskkill /F /PID %%P`. Targets the listening PID directly.

All three fixes committed as `d580626 launcher-windows: fix three e2e bugs caught during eyes-on`. The eyes-on run **caught** the bugs — methodology working as intended.

## CRLF / encoding gotcha worth documenting

The Write tool produces LF line endings. cmd.exe needs CRLF. My initial launcher.bat ran as one giant token and produced errors like `'See' is not recognized as an internal or external command`. Fix:

```powershell
$c = Get-Content launcher.bat -Raw
$crlf = $c -replace "`r?`n", "`r`n"
[System.IO.File]::WriteAllText("$pwd\launcher.bat", $crlf, [System.Text.Encoding]::ASCII)
```

`.gitattributes` (committed in commit 3) handles this for subsequent clones — but not for the initial write inside a single session. Worth knowing.

ASCII encoding strips Unicode (em-dashes turn into `???`). I rewrote launcher.bat with ASCII-only characters everywhere.

## Spec checklist

- [x] All three launcher files exist with correct extensions and perms (file smoke + git index mode 100755 on .command/.sh)
- [x] Each contains ARGOS_ROOT resolution from script directory (three-layout sniff)
- [x] Each contains stage markers `[1/4]..[4/4]` and cleanup logic
- [x] **Windows .bat manual e2e:** launcher runs → stages print → :7799 responds 200 → chat POST succeeds → cleanup kills the Next.js listener cleanly. Three real bugs fixed mid-eyes-on.
- [ ] **macOS .command manual e2e:** **not driven** — no Mac available. Code-verified via smoke + line-by-line review.
- [ ] **Linux .sh manual e2e:** **not driven** — no Linux box available. Code-verified.
- [x] Cold-start time observed (with warm daemon): sub-second polling-loop reactions. Genuine cold-start measurement is an H8 USB-drive task.
- [x] Logs written to `ARGOS_ROOT/logs/`, not host (`E:\Argos_Claude\logs\next.log` created during the run, no host writes).
- [ ] **Re-launch immediately after exit:** code-verified (the cleanup releases port; second launcher invocation would find the port free). Not driven live.
- [x] Splash output is clear (header + four stages + key-to-shutdown prompt). Not noisy.
- [x] **Network tab:** all browser traffic in the chat e2e was localhost only.

## Filesystem-diff verification

```
ARGOS_ROOT/logs/next.log     created, 100 bytes
ARGOS_ROOT/logs/ollama.log   NOT created (our second Ollama start failed silently because tray daemon already owned :11434 — expected)
APPDATA recent files (5 min window, filtered): 0
```

Zero new files in `%APPDATA%` attributable to the launcher run. Logs went to ARGOS_ROOT, not to host.

## Platform-specific gotchas hit on this run

1. **CRLF requirement on .bat** — fixed by post-write PowerShell normalisation. Documented above and in `.gitattributes`.
2. **Parens-in-echo block delimiter ambiguity** — escape with `^(` `^)`. Fixed in `d580626`.
3. **`if exist` does not resolve `..\`** — canonicalise first via for-loop. Fixed in `d580626`.
4. **Next.js renames its console title** — netstat-based cleanup instead of title-match. Fixed in `d580626`.
5. **Running launcher locally on a box with a host Ollama tray daemon** — the launcher's IM-kill backup will terminate the tray daemon. This is the documented USB-isolated-scenario cost. For dev local-runs, manually kill via netstat-cleanup-without-IM-kill (the code is right there in the CLEANUP label; remove the `taskkill /F /IM ollama.exe` line for dev-only safe invocations).

## What's still browser-eyes-on for the human (and for H8)

- Genuine cold-start time on the ThinkPad target (no warm daemon, model not in RAM)
- macOS .command end-to-end: Gatekeeper bypass on first launch, trap-cleanup on Terminal close
- Linux .sh end-to-end: xdg-open vs headless DISPLAY-unset path
- Full host-filesystem diff comparing before/after launcher run (PowerShell `Get-ChildItem -Recurse` snapshot pre + post + diff)
- Re-launch immediately after clean shutdown — both ports clean within 1 second
- USB-yank graceful error path
