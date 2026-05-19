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
if exist "%SCRIPT_DIR%\app\package.json" (
  set "ARGOS_ROOT=%SCRIPT_DIR%"
  set "NEXTJS_DIR=%SCRIPT_DIR%\app"
) else if exist "%SCRIPT_DIR%\package.json" (
  set "ARGOS_ROOT=%SCRIPT_DIR%"
  set "NEXTJS_DIR=%SCRIPT_DIR%"
) else if exist "%SCRIPT_DIR%\..\package.json" (
  for %%I in ("%SCRIPT_DIR%\..") do set "ARGOS_ROOT=%%~fI"
  for %%I in ("%SCRIPT_DIR%\..") do set "NEXTJS_DIR=%%~fI"
) else (
  echo [ERROR] Could not locate ARGOS Next.js app from %SCRIPT_DIR%
  echo Expected one of:
  echo   %SCRIPT_DIR%\app\package.json   (post-H8 USB layout)
  echo   %SCRIPT_DIR%\package.json       (launcher at repo root)
  echo   %SCRIPT_DIR%\..\package.json    (pre-H8 dev with launchers\ subdir)
  pause
  exit /b 1
)

REM --- Scoped env vars (child processes only) -----------------
set "NEXT_TELEMETRY_DISABLED=1"
set "OLLAMA_MODELS=%ARGOS_ROOT%\models"
set "TMPDIR=%ARGOS_ROOT%\tmp"

REM --- Ensure runtime dirs ------------------------------------
if not exist "%ARGOS_ROOT%\logs" mkdir "%ARGOS_ROOT%\logs"
if not exist "%ARGOS_ROOT%\tmp" mkdir "%ARGOS_ROOT%\tmp"

REM --- Locate Ollama binary (bundled first, system fallback) --
set "OLLAMA_BIN="
if exist "%ARGOS_ROOT%\bin\ollama.exe" set "OLLAMA_BIN=%ARGOS_ROOT%\bin\ollama.exe"
if "%OLLAMA_BIN%"=="" if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_BIN=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if "%OLLAMA_BIN%"=="" (
  echo [ERROR] Ollama binary not found.
  echo Expected one of:
  echo   %ARGOS_ROOT%\bin\ollama.exe                          (bundled — H8 will populate this)
  echo   %LOCALAPPDATA%\Programs\Ollama\ollama.exe            (system install)
  pause
  exit /b 1
)

set "LAUNCHER_LOG=%ARGOS_ROOT%\logs\launcher.log"
set "OLLAMA_LOG=%ARGOS_ROOT%\logs\ollama.log"
set "NEXT_LOG=%ARGOS_ROOT%\logs\next.log"

echo.
echo  ARGOS — local-first AI workstation
echo  --------------------------------------------------------
echo  ARGOS_ROOT  %ARGOS_ROOT%
echo  Next.js     %NEXTJS_DIR%
echo  Ollama      %OLLAMA_BIN%
echo  Logs        %ARGOS_ROOT%\logs\
echo.

REM ====== Stage 1/4: start Ollama ============================
echo [1/4] Starting Ollama on 127.0.0.1:11434...
start "ARGOS-OLLAMA" /MIN "%OLLAMA_BIN%" serve

set /a TRIES=0
:WAIT_OLLAMA
set /a TRIES+=1
curl -fs --max-time 2 http://127.0.0.1:11434/api/tags >NUL 2>&1
if %errorlevel%==0 goto OLLAMA_READY
if %TRIES% GEQ 30 (
  echo [ERROR] Ollama did not respond within 30s. See %OLLAMA_LOG%
  goto CLEANUP_FAIL
)
echo    ... waiting (%TRIES%/30)
timeout /t 1 /nobreak >NUL
goto WAIT_OLLAMA

:OLLAMA_READY
echo [2/4] Ollama ready on port 11434

REM ====== Stage 3/4: start Next.js prod server ===============
echo [3/4] Starting Next.js on 127.0.0.1:7799...
pushd "%NEXTJS_DIR%"
start "ARGOS-NEXT" /MIN cmd /c "node node_modules\next\dist\bin\next start -p 7799 1>>""%NEXT_LOG%"" 2>&1"
popd

set /a TRIES=0
:WAIT_NEXT
set /a TRIES+=1
curl -fs --max-time 2 http://127.0.0.1:7799 >NUL 2>&1
if %errorlevel%==0 goto NEXT_READY
if %TRIES% GEQ 30 (
  echo [ERROR] Next.js did not respond within 30s. See %NEXT_LOG%
  goto CLEANUP_FAIL
)
echo    ... waiting (%TRIES%/30)
timeout /t 1 /nobreak >NUL
goto WAIT_NEXT

:NEXT_READY
echo [4/4] ARGOS ready — opening browser at http://127.0.0.1:7799
start "" http://127.0.0.1:7799
echo.
echo  ARGOS is running.
echo  Press any key to shut down ARGOS cleanly.
echo  (X-closing this window orphans the daemon windows — close them by hand if you do.)
echo.
pause >NUL

:CLEANUP
echo Shutting down...
taskkill /FI "WINDOWTITLE eq ARGOS-NEXT*" >NUL 2>&1
taskkill /FI "WINDOWTITLE eq ARGOS-OLLAMA*" >NUL 2>&1
timeout /t 1 /nobreak >NUL
taskkill /F /FI "WINDOWTITLE eq ARGOS-NEXT*" >NUL 2>&1
taskkill /F /FI "WINDOWTITLE eq ARGOS-OLLAMA*" >NUL 2>&1
REM Backup: kill any remaining ollama child by image name
taskkill /F /IM ollama.exe >NUL 2>&1
echo Done.
exit /b 0

:CLEANUP_FAIL
echo Attempting cleanup of any started daemons...
taskkill /F /FI "WINDOWTITLE eq ARGOS-NEXT*" >NUL 2>&1
taskkill /F /FI "WINDOWTITLE eq ARGOS-OLLAMA*" >NUL 2>&1
pause
exit /b 1
