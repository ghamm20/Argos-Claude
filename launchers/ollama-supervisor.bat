@echo off
REM ============================================================
REM  ARGOS Ollama watchdog-supervisor (Phase 2.x rider, 2026-06-10)
REM
REM  WHY: Ollama died twice in 24h. Both were SESSION TEARDOWN, not
REM  crashes: Winlogon LOGOFF 6/9 22:29:09 paired 1s with the managed
REM  server exiting 0x40010004 (console-control termination); zero
REM  Application-log fault events at either window; server.log healthy
REM  to the last line (OOM ruled out). Ollama only ever ran session-
REM  bound (tray app or ad-hoc console serve) with no survival mode.
REM
REM  WHAT: probe /api/tags every 15s.
REM    healthy -> keep watching. This ADOPTS a reused host daemon (the
REM               launcher's REUSE path): if a borrowed daemon dies,
REM               the watchdog takes over and serves from here on.
REM    dead    -> start "ollama serve" BLOCKING; on ANY exit, log the
REM               code and loop (restart-on-exit, 2s backoff).
REM  STOP: the launcher creates the stop-flag file at cleanup; the
REM  watchdog exits at the next loop turn (and the launcher F-kills the
REM  watchdog window as belt-and-braces).
REM
REM  USB-native: no Windows service, no scheduled task, no registry
REM  writes, no host persistence — travels with the payload (Seven
REM  Rules compliant; works unchanged on the M.2 at Phase 10). The
REM  residual limit: the watchdog lives in the session that ran the
REM  launcher (the desk console). Remote-session teardowns can no
REM  longer take Ollama down with them; only closing the launcher's
REM  own session can — and that is the operator shutting ARGOS down.
REM
REM  Args: %1 ollama.exe path   %2 port   %3 log file   %4 stop-flag
REM ============================================================
set "OLLAMA_BIN=%~1"
set "WD_PORT=%~2"
set "WD_LOG=%~3"
set "STOPFLAG=%~4"

echo [ollama-wd] %date% %time% watchdog up (port %WD_PORT%, bin "%OLLAMA_BIN%", stopflag "%STOPFLAG%") >>"%WD_LOG%"

:loop
REM Stop check is two-stage: `if exist` (FindFirstFile) can return true for a
REM DELETE-PENDING ghost entry — observed twice on 2026-06-10, where it fired
REM with no file present to Test-Path/dir. The flag only counts if it is
REM actually READABLE (`type` succeeds); a ghost fails the read and is
REM logged + ignored. The launcher writes real content ("stop") to the flag.
if not exist "%STOPFLAG%" goto alive
type "%STOPFLAG%" >NUL 2>&1
if not errorlevel 1 (
  echo [ollama-wd] %date% %time% stop flag confirmed at "%STOPFLAG%" - exiting >>"%WD_LOG%"
  exit /b 0
)
echo [ollama-wd] %date% %time% WARN ghost stop flag (if-exist true, unreadable) - ignoring >>"%WD_LOG%"
dir "%STOPFLAG%" >>"%WD_LOG%" 2>&1
:alive
REM Sleeps use ping, NOT timeout: timeout.exe hard-fails ("Input redirection
REM is not supported") when stdin is NUL — and the launcher spawns this
REM script with < NUL precisely to survive non-console invocation. ping -n
REM (N+1) 127.0.0.1 sleeps ~N seconds and needs no console stdin.
curl -fs --max-time 2 http://127.0.0.1:%WD_PORT%/api/tags >NUL 2>&1
if %errorlevel%==0 (
  ping -n 16 127.0.0.1 >NUL
  goto loop
)
if "%OLLAMA_BIN%"=="" (
  echo [ollama-wd] %date% %time% daemon down but no ollama binary known - rewatch in 15s >>"%WD_LOG%"
  ping -n 16 127.0.0.1 >NUL
  goto loop
)
echo [ollama-wd] %date% %time% daemon down - starting ollama serve >>"%WD_LOG%"
"%OLLAMA_BIN%" serve >>"%WD_LOG%" 2>&1
echo [ollama-wd] %date% %time% ollama serve exited (code %errorlevel%) - restart in 2s >>"%WD_LOG%"
ping -n 3 127.0.0.1 >NUL
goto loop
