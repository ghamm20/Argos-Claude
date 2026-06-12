@echo off
REM ============================================================
REM  ARGOS Tool Launcher — Oculus OSINT
REM  Boots Oculus (Postgres + Next.js) via Docker Compose
REM  Port: 3011  Health: http://127.0.0.1:3011/api/health
REM ============================================================
setlocal enabledelayedexpansion

REM --- Resolve Oculus root ---
if defined OCULUS_ROOT (
    set "OCULUS_DIR=%OCULUS_ROOT%"
) else (
    REM Phase 9 (2026-06-10): canonical Oculus = ghamm20/Oculus_Osint at C:\AI
    REM (old Desktop\Oculus-osint-main deleted). D:\OCULUS is the Phase-10 target.
    set "OCULUS_DIR=C:\AI\OCULUSBOUND\Oculus-osint-main"
)

if not exist "%OCULUS_DIR%" (
    echo [OCULUS] ERROR: Root not found at %OCULUS_DIR%
    echo [OCULUS] Set OCULUS_ROOT env var or update registry.json rootDefault
    exit /b 1
)

REM --- Verify Docker is running; start Docker Desktop if not (Gate C
REM durable fix, 2026-06-12). Mirrors the launcher's logic so a MANUAL
REM start.bat run is just as durable. ping-based sleeps only: this script
REM runs with < NUL stdin from the launcher, where timeout.exe hard-fails.
docker info >nul 2>&1
if not errorlevel 1 goto :docker_ok

echo [OCULUS] Docker engine not running - starting Docker Desktop...
set "DOCKER_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if exist "!DOCKER_EXE!" goto :docker_spawn
set "DOCKER_EXE=%LOCALAPPDATA%\Docker\Docker Desktop.exe"
if exist "!DOCKER_EXE!" goto :docker_spawn
echo [OCULUS] ERROR: Docker Desktop not found. Install it or start the engine, then re-run.
exit /b 1

:docker_spawn
start "" "!DOCKER_EXE!"
echo [OCULUS] Docker Desktop launched - waiting for the engine (up to 180s)...
set /a dktries=0
:docker_wait
set /a dktries+=1
docker info >nul 2>&1
if not errorlevel 1 goto :docker_ok
if !dktries! gtr 36 (
    echo [OCULUS] ERROR: Docker engine NOT READY after 180s. Start Docker Desktop manually, then re-run.
    exit /b 1
)
ping -n 6 127.0.0.1 >nul
goto :docker_wait

:docker_ok

REM --- Copy ARGOS-managed compose override if it doesn't exist ---
REM 2026-06-11: the copy failure was swallowed by >nul and compose then died
REM on the missing file. Verify the file actually landed; fail LOUDLY if not.
if not exist "%OCULUS_DIR%\docker-compose.argos.yml" (
    copy "%~dp0docker-compose.argos.yml" "%OCULUS_DIR%\docker-compose.argos.yml" >nul 2>&1
)
if not exist "%OCULUS_DIR%\docker-compose.argos.yml" (
    echo [OCULUS] ERROR: compose override missing and copy from %~dp0 failed.
    exit /b 1
)

REM --- Boot Oculus ---
echo [OCULUS] Starting Oculus OSINT on port 3011...
cd /d "%OCULUS_DIR%"

docker compose -f docker-compose.argos.yml up -d --build 2>&1 | findstr /v "^#"

if errorlevel 1 (
    echo [OCULUS] ERROR: docker compose failed.
    exit /b 1
)

REM --- Wait for health check (max 60s) ---
echo [OCULUS] Waiting for health check at http://127.0.0.1:3011/api/health ...
set /a attempts=0
:health_loop
set /a attempts+=1
if !attempts! gtr 12 (
    echo [OCULUS] WARNING: Health check timed out after 60s. May still be starting.
    goto :done
)
REM ping, not timeout: timeout.exe hard-fails ("Input redirection is not
REM supported") under the < NUL stdin the launcher spawns this script with.
ping -n 6 127.0.0.1 >nul
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:3011/api/health 2>nul | findstr "200" >nul
if not errorlevel 1 (
    echo [OCULUS] Ready at http://127.0.0.1:3011
    goto :done
)
echo [OCULUS] Not ready yet... attempt !attempts!/12
goto :health_loop

:done
endlocal
exit /b 0
