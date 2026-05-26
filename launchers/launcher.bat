@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  ARGOS USB-native launcher (Windows)
REM
REM  See launchers/README.md for the full design and the five-point
REM  acceptance contract this script must hold.
REM
REM  No PowerShell calls. curl ships with Windows 10+.
REM ============================================================

REM --- Resolve script dir (no trailing backslash) -------------
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

REM --- Layout sniff (post-H8 / repo-root / pre-H8 dev) --------
REM  Canonicalize parent dir first; cmd 'if exist' does not resolve
REM  '..' segments embedded in a path, so we expand via for-loop.
set "PARENT_DIR="
for %%I in ("%SCRIPT_DIR%\..") do set "PARENT_DIR=%%~fI"

if exist "%SCRIPT_DIR%\app\package.json" (
  set "ARGOS_ROOT=%SCRIPT_DIR%"
  set "NEXTJS_DIR=%SCRIPT_DIR%\app"
) else if exist "%SCRIPT_DIR%\package.json" (
  set "ARGOS_ROOT=%SCRIPT_DIR%"
  set "NEXTJS_DIR=%SCRIPT_DIR%"
) else if exist "%PARENT_DIR%\package.json" (
  set "ARGOS_ROOT=%PARENT_DIR%"
  set "NEXTJS_DIR=%PARENT_DIR%"
) else (
  echo [ERROR] Could not locate ARGOS Next.js app from %SCRIPT_DIR%
  echo Expected one of:
  echo   %SCRIPT_DIR%\app\package.json   ^(post-H8 USB layout^)
  echo   %SCRIPT_DIR%\package.json       ^(launcher at repo root^)
  echo   %PARENT_DIR%\package.json       ^(pre-H8 dev with launchers\ subdir^)
  pause
  exit /b 1
)

REM --- Scoped env vars (child processes only) -----------------
set "NEXT_TELEMETRY_DISABLED=1"
REM Default OLLAMA_MODELS to the USB-payload location, but respect a
REM caller-provided value (smoke tests, devs running against host models).
if not defined OLLAMA_MODELS set "OLLAMA_MODELS=C:\\Users\\Gordy\\.ollama\\models"
set "TMPDIR=%ARGOS_ROOT%\tmp"
REM OLLAMA_HOST is resolved in the Port resolution block below — a
REM caller-set value is honored, otherwise we pick 11434/11435 by
REM netstat pre-flight and set OLLAMA_HOST to match. Both ollama
REM daemon and the Next.js app read OLLAMA_HOST (lib/ollama-config.ts).

REM --- Ensure runtime dirs ------------------------------------
if not exist "%ARGOS_ROOT%\logs" mkdir "%ARGOS_ROOT%\logs"
if not exist "%ARGOS_ROOT%\tmp" mkdir "%ARGOS_ROOT%\tmp"

REM --- Port resolution with fallback (Phase 1) ----------------
REM  Primary ports: Ollama 11434, Next.js 7799.
REM  Fallback ports: Ollama 11435, Next.js 7800.
REM  Honors a caller-set OLLAMA_HOST (skips Ollama-side fallback in that
REM  case; the caller knows where it wants the daemon).
if defined OLLAMA_HOST (
  REM Parse port from caller-set OLLAMA_HOST (format host:port; IPv4 only).
  for /f "tokens=2 delims=:" %%P in ("!OLLAMA_HOST!") do set "OLLAMA_PORT=%%P"
) else (
  set "OLLAMA_PORT=11434"
  call :PORT_IN_USE 11434
  if !errorlevel!==0 (
    echo [INFO] Port 11434 in use; falling back to 11435.
    set "OLLAMA_PORT=11435"
    call :PORT_IN_USE 11435
    if !errorlevel!==0 (
      echo [ERROR] Both Ollama ports 11434 and 11435 are in use.
      echo         Free one of them and re-run.
      pause
      exit /b 1
    )
  )
  set "OLLAMA_HOST=127.0.0.1:!OLLAMA_PORT!"
)

set "NEXT_PORT=7799"
call :PORT_IN_USE 7799
if !errorlevel!==0 (
  echo [INFO] Port 7799 in use; falling back to 7800.
  set "NEXT_PORT=7800"
  call :PORT_IN_USE 7800
  if !errorlevel!==0 (
    echo [ERROR] Both Next.js ports 7799 and 7800 are in use.
    echo         Free one of them and re-run.
    pause
    exit /b 1
  )
)

REM --- Locate Ollama binary (bundled first, system fallback, PATH fallback) --
set "OLLAMA_BIN="
if exist "%ARGOS_ROOT%\bin\ollama.exe" set "OLLAMA_BIN=%ARGOS_ROOT%\bin\ollama.exe"
if "%OLLAMA_BIN%"=="" if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_BIN=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if "%OLLAMA_BIN%"=="" (
  for /f "delims=" %%I in ('where ollama 2^>NUL') do (
    if not defined OLLAMA_BIN set "OLLAMA_BIN=%%I"
  )
)
if "%OLLAMA_BIN%"=="" (
  echo [ERROR] Ollama binary not found.
  echo Expected one of:
  echo   %ARGOS_ROOT%\bin\ollama.exe                  ^(bundled - shipped by migrate-to-usb^)
  echo   %LOCALAPPDATA%\Programs\Ollama\ollama.exe    ^(system install via winget^)
  echo   any ollama.exe on PATH
  pause
  exit /b 1
)

set "LAUNCHER_LOG=%ARGOS_ROOT%\logs\launcher.log"
set "OLLAMA_LOG=%ARGOS_ROOT%\logs\ollama.log"
set "NEXT_LOG=%ARGOS_ROOT%\logs\next.log"

REM --- Log rotation (Phase 1) ---------------------------------
REM  Roll each log if it exceeds 10 MB. Keep 3 generations (.1 .2 .3).
REM  Done before daemons start so the rename can succeed (no open handles).
call :ROTATE_LOG "%LAUNCHER_LOG%"
call :ROTATE_LOG "%OLLAMA_LOG%"
call :ROTATE_LOG "%NEXT_LOG%"

echo.
echo  ARGOS - local-first AI workstation
echo  --------------------------------------------------------
echo  ARGOS_ROOT  %ARGOS_ROOT%
echo  Next.js     %NEXTJS_DIR%
echo  Ollama      %OLLAMA_BIN%
echo  Ports       Ollama %OLLAMA_PORT%  Next.js %NEXT_PORT%
echo  Logs        %ARGOS_ROOT%\logs\
echo.

REM ====== Stage 1/4: start Ollama ============================
REM Wrap with cmd /c so stdout+stderr redirect to logs. Without this,
REM if ollama serve dies on startup (missing lib/ runtime, port held,
REM etc.) the operator sees the launcher loop on "waiting (N/30)" with
REM no clue why. See methodology/corrections.md 2026-05-20 entry.
REM
REM Quote-escaping rule for cmd /c "...": embed a literal " by doubling
REM it ("" inside the outer-quoted command). Same pattern as the
REM ARGOS-NEXT line below. Tolerates OLLAMA_BIN paths with spaces.
REM
REM < NUL redirects stdin from the NUL device, so the child cmd does
REM not inherit a piped stdin from a non-interactive parent. Without
REM this, when the launcher is invoked from a non-console context
REM (verification harness, CI, headless wrapper), cmd dies with
REM "ERROR: Input redirection is not supported" before ollama even
REM starts. The Phase C investigation on 2026-05-20 confirmed the
REM underlying ollama binary works (binds 127.0.0.1:11435 in 105ms
REM via PowerShell Start-Process); the failure was always at the
REM cmd /c wrapper layer.
echo [1/4] Starting Ollama on 127.0.0.1:%OLLAMA_PORT%...
start "ARGOS-OLLAMA" /MIN cmd /c """%OLLAMA_BIN%"" serve < NUL 1>>""%OLLAMA_LOG%"" 2>&1"

set /a TRIES=0
:WAIT_OLLAMA
set /a TRIES+=1
curl -fs --max-time 2 http://127.0.0.1:%OLLAMA_PORT%/api/tags >NUL 2>&1
if %errorlevel%==0 goto OLLAMA_READY
if %TRIES% GEQ 30 (
  echo [ERROR] Ollama did not respond within 30s.
  echo         daemon stderr captured to: %OLLAMA_LOG%
  echo         Read that file for the actual failure reason.
  goto CLEANUP_FAIL
)
echo    ... waiting (%TRIES%/30)
timeout /t 1 /nobreak >NUL
goto WAIT_OLLAMA

:OLLAMA_READY
echo [2/4] Ollama ready on port %OLLAMA_PORT%

REM ====== Stage 3/4: start Next.js prod server ===============
REM Same < NUL stdin-detach as the Ollama line above — defends against
REM non-console invocation contexts. node ignores stdin in `next start`
REM mode but the wrapping cmd /c is still vulnerable.
echo [3/4] Starting Next.js on 127.0.0.1:%NEXT_PORT%...
pushd "%NEXTJS_DIR%"
start "ARGOS-NEXT" /MIN cmd /c "node node_modules\next\dist\bin\next start -p %NEXT_PORT% < NUL 1>>""%NEXT_LOG%"" 2>&1"
popd

set /a TRIES=0
:WAIT_NEXT
set /a TRIES+=1
curl -fs --max-time 2 http://127.0.0.1:%NEXT_PORT% >NUL 2>&1
if %errorlevel%==0 goto NEXT_READY
if %TRIES% GEQ 30 (
  echo [ERROR] Next.js did not respond within 30s. See %NEXT_LOG%
  goto CLEANUP_FAIL
)
echo    ... waiting (%TRIES%/30)
timeout /t 1 /nobreak >NUL
goto WAIT_NEXT

:NEXT_READY
echo [4/4] ARGOS ready - opening browser at http://127.0.0.1:%NEXT_PORT%
start "" http://127.0.0.1:%NEXT_PORT%

REM ============================================================
REM  Phase 3: auto-ingest any files dropped in vault/dropbox/
REM  Fire-and-forget — failure here does not block ARGOS startup.
REM  Output goes to logs/launcher.log; UI also shows the new docs.
REM ============================================================
echo Auto-ingest check (vault/dropbox)...
curl -fs --max-time 60 -X POST http://127.0.0.1:%NEXT_PORT%/api/vault/auto-ingest 1>>"%LAUNCHER_LOG%" 2>>"%LAUNCHER_LOG%"

REM ============================================================
REM  Phase 5: voice presence-check.
REM  Pure read-only probe — never spawns the binaries. If either
REM  whisper or kokoro is missing, the UI hides its button + the
REM  audit chain logs no voice events. Operator installs per
REM  tools/voice/README.md.
REM ============================================================
set "VOICE_WHISPER=missing"
REM Phase 7-B: TTS variable renamed from VOICE_KOKORO → VOICE_TTS
REM since Piper replaced Kokoro as the canonical engine. Default
REM "missing" set at the bottom after all probes.
if exist "%ARGOS_ROOT%\tools\voice\whisper\whisper-cli.exe" set "VOICE_WHISPER=ready"
if exist "%ARGOS_ROOT%\tools\voice\whisper\whisper.exe"     set "VOICE_WHISPER=ready"
if exist "%ARGOS_ROOT%\tools\voice\whisper\main.exe"        set "VOICE_WHISPER=ready"
if exist "%ARGOS_ROOT%\tools\voice\kokoro\kokoros.exe"      set "VOICE_TTS=ready"
if exist "%ARGOS_ROOT%\tools\voice\kokoro\kokoro.exe"       set "VOICE_TTS=ready"
REM Phase 7-B: Piper is the canonical TTS engine (real Windows binaries).
REM Kept Kokoro checks above for the case operator builds kokoros from source.
if exist "%ARGOS_ROOT%\tools\voice\piper\piper.exe"         set "VOICE_TTS=ready"
if not defined VOICE_TTS set "VOICE_TTS=missing"
echo [voice] whisper STT %VOICE_WHISPER%  ^|  TTS %VOICE_TTS%
echo Voice scan: whisper=%VOICE_WHISPER% tts=%VOICE_TTS% >>"%LAUNCHER_LOG%"

REM ============================================================
REM  Tool integration (post-Phase-1 patch)
REM  Boots Oculus + SuperAGI in background via docker compose.
REM  Skips silently if Docker Desktop isn't running.
REM  See tools/registry.json for the full tool list and LAUNCHER_PATCH.bat
REM  in the integration package for the canonical source of this block.
REM ============================================================
if not defined OCULUS_ROOT      set "OCULUS_ROOT=C:\Users\Gordy\Desktop\Oculus-osint-main"
if not defined SUPERAGI_ROOT    set "SUPERAGI_ROOT=F:\AI\SuperAGI"
if not defined LOOKINGGLASS_ROOT set "LOOKINGGLASS_ROOT=E:\AgenticLookingGlass"

docker info >nul 2>&1
if errorlevel 1 (
    echo [TOOLS] Docker Desktop not running. Skipping tool auto-start.
    echo [TOOLS] Tools available via Tools Dock once Docker is up; or run start.bat manually.
    goto :skip_tools
)

REM  cmd /c spawn pattern mirrors the OLLAMA/NEXT spawns above:
REM  triple-quote escaping ("" inside the outer "...") tolerates paths
REM  with spaces; < NUL detaches stdin (Phase C/E lesson, Rule 7).
echo [5/6] Starting Oculus OSINT ^(port 3011^)...
start "ARGOS-Oculus" /MIN cmd /c """%ARGOS_ROOT%\tools\oculus\start.bat"" < NUL 1>>""%ARGOS_ROOT%\logs\oculus.log"" 2>&1"

echo [6/6] Starting SuperAGI ^(port 3002^)...
start "ARGOS-SuperAGI" /MIN cmd /c """%ARGOS_ROOT%\tools\superagi\start.bat"" < NUL 1>>""%ARGOS_ROOT%\logs\superagi.log"" 2>&1"

echo.
echo  Tools booting in background. Status in the ARGOS Tools dock.
echo  Oculus:   http://127.0.0.1:3011
echo  SuperAGI: http://127.0.0.1:3002

:skip_tools

echo.
echo  ARGOS is running.
echo  Press any key to shut down ARGOS cleanly.
echo  ^(X-closing this window orphans the daemon windows - close them by hand if you do.^)
echo.
pause >NUL

:CLEANUP
echo Shutting down...
REM  Next.js renames its cmd-window title to "next-server (vX.Y.Z)" once
REM  the server is up, so taskkill by ARGOS-NEXT title misses it.
REM  Resolve via netstat: kill whoever is listening on 7799.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%NEXT_PORT% " ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >NUL 2>&1
)
REM  Ollama gets the title-match path; if our launcher started it the
REM  title sticks because ollama serve does not rename its window.
taskkill /F /FI "WINDOWTITLE eq ARGOS-OLLAMA*" >NUL 2>&1
REM  Backup for an orphan Ollama child started by THIS launcher. Note:
REM  this also kills any host-installed Ollama tray daemon - known
REM  cost for the USB-isolated scenario where ARGOS owns Ollama
REM  exclusively. See launchers/README.md.
taskkill /F /IM ollama.exe >NUL 2>&1

REM --- Stop tool integration (post-Phase-1 patch) ---
REM  Idempotent: stop.bat's docker compose down is safe if tool wasn't running.
REM  Errors swallowed so a missing/un-bootable tool can't block ARGOS shutdown.
if exist "%ARGOS_ROOT%\tools\oculus\stop.bat" (
    echo Stopping Oculus...
    call "%ARGOS_ROOT%\tools\oculus\stop.bat" >NUL 2>&1
)
if exist "%ARGOS_ROOT%\tools\superagi\stop.bat" (
    echo Stopping SuperAGI...
    call "%ARGOS_ROOT%\tools\superagi\stop.bat" >NUL 2>&1
)

echo Done.
exit /b 0

:CLEANUP_FAIL
echo Attempting cleanup of any started daemons...
taskkill /F /FI "WINDOWTITLE eq ARGOS-NEXT*" >NUL 2>&1
taskkill /F /FI "WINDOWTITLE eq ARGOS-OLLAMA*" >NUL 2>&1
pause
exit /b 1

REM ============================================================
REM  Subroutines (Phase 1)
REM ============================================================

:PORT_IN_USE
REM  Returns errorlevel 0 if TCP port %1 has a LISTENING entry, else nonzero.
REM  Trailing space in the netstat pattern avoids prefix-collision (e.g. 11434 vs 114340).
netstat -ano | findstr ":%~1 " | findstr "LISTENING" >NUL 2>&1
exit /b %errorlevel%

:ROTATE_LOG
REM  Rotate %1 if it exceeds 10 MB. Keep 3 backups: .1 (newest), .2, .3 (oldest).
REM  10 MB = 10485760 bytes. cmd %%~z gives file size as integer.
set "LOG_FILE=%~1"
if not exist "%LOG_FILE%" exit /b 0
set "FILE_SIZE=0"
for %%I in ("%LOG_FILE%") do set "FILE_SIZE=%%~zI"
if %FILE_SIZE% LSS 10485760 exit /b 0
if exist "%LOG_FILE%.3" del /F /Q "%LOG_FILE%.3" >NUL 2>&1
if exist "%LOG_FILE%.2" move /Y "%LOG_FILE%.2" "%LOG_FILE%.3" >NUL 2>&1
if exist "%LOG_FILE%.1" move /Y "%LOG_FILE%.1" "%LOG_FILE%.2" >NUL 2>&1
move /Y "%LOG_FILE%" "%LOG_FILE%.1" >NUL 2>&1
exit /b 0

