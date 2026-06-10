@echo off
REM ARGOS Tool Stop — Oculus OSINT
setlocal

if defined OCULUS_ROOT (set "OCULUS_DIR=%OCULUS_ROOT%") else (set "OCULUS_DIR=C:\Users\Gordy\Desktop\Oculus-osint-main")

echo [OCULUS] Stopping Oculus OSINT...
cd /d "%OCULUS_DIR%"
docker compose -f docker-compose.argos.yml down
echo [OCULUS] Stopped.
endlocal
