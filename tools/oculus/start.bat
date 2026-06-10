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

REM --- Verify Docker is running ---
docker info >nul 2>&1
if errorlevel 1 (
    echo [OCULUS] ERROR: Docker Desktop is not running. Start Docker first.
    exit /b 1
)

REM --- Copy ARGOS-managed compose override if it doesn't exist ---
if not exist "%OCULUS_DIR%\docker-compose.argos.yml" (
    copy "%~dp0docker-compose.argos.yml" "%OCULUS_DIR%\docker-compose.argos.yml" >nul
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
timeout /t 5 /nobreak >nul
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
