#!/bin/bash
# ============================================================
#  ARGOS USB-native launcher (Linux)
#
#  See launchers/README.md for the design and the five-point
#  acceptance contract.
#
#  Headless ($DISPLAY unset): the launcher prints the URL and
#  skips xdg-open. Use it from another machine on the same host.
# ============================================================

set -eo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

if [ -f "$SCRIPT_DIR/app/package.json" ]; then
  ARGOS_ROOT="$SCRIPT_DIR"
  NEXTJS_DIR="$SCRIPT_DIR/app"
elif [ -f "$SCRIPT_DIR/package.json" ]; then
  ARGOS_ROOT="$SCRIPT_DIR"
  NEXTJS_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../package.json" ]; then
  ARGOS_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
  NEXTJS_DIR="$ARGOS_ROOT"
else
  echo "[ERROR] Could not locate ARGOS Next.js app from $SCRIPT_DIR" >&2
  exit 1
fi

export ARGOS_ROOT
export NEXT_TELEMETRY_DISABLED=1
# Default to the USB-payload location, but respect caller-provided override
# (smoke tests, devs pointing at host models).
export OLLAMA_MODELS="${OLLAMA_MODELS:-$ARGOS_ROOT/models}"
export TMPDIR="$ARGOS_ROOT/tmp"
# OLLAMA_HOST is resolved in the Port resolution block below — a
# caller-set value is honored, otherwise we pick 11434/11435 by
# port pre-flight and set OLLAMA_HOST to match. Both ollama daemon
# and the Next.js app read OLLAMA_HOST (lib/ollama-config.ts).

mkdir -p "$ARGOS_ROOT/logs" "$ARGOS_ROOT/tmp"

# --- Port resolution with fallback (Phase 1) ----------------
# Primary: Ollama 11434, Next.js 7799. Fallback: 11435 / 7800.
# Honors caller-set OLLAMA_HOST (skips Ollama-side fallback in that case).
port_in_use() {
  # Returns 0 if a process is listening on 127.0.0.1:$1, nonzero otherwise.
  # bash /dev/tcp works in bash 2.04+ on both macOS (3.2) and Linux.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && { exec 3<&- 3>&-; return 0; }
  return 1
}

if [ -n "${OLLAMA_HOST:-}" ]; then
  OLLAMA_PORT="${OLLAMA_HOST##*:}"
else
  OLLAMA_PORT=11434
  if port_in_use 11434; then
    echo "[INFO] Port 11434 in use; falling back to 11435."
    OLLAMA_PORT=11435
    if port_in_use 11435; then
      echo "[ERROR] Both Ollama ports 11434 and 11435 are in use. Free one and re-run." >&2
      exit 1
    fi
  fi
  export OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT"
fi

NEXT_PORT=7799
if port_in_use 7799; then
  echo "[INFO] Port 7799 in use; falling back to 7800."
  NEXT_PORT=7800
  if port_in_use 7800; then
    echo "[ERROR] Both Next.js ports 7799 and 7800 are in use. Free one and re-run." >&2
    exit 1
  fi
fi

OLLAMA_BIN=""
if [ -x "$ARGOS_ROOT/bin/ollama-linux" ]; then
  OLLAMA_BIN="$ARGOS_ROOT/bin/ollama-linux"
elif [ -x "$ARGOS_ROOT/bin/ollama" ]; then
  OLLAMA_BIN="$ARGOS_ROOT/bin/ollama"
elif command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="$(command -v ollama)"
fi
if [ -z "$OLLAMA_BIN" ]; then
  echo "[ERROR] Ollama binary not found. Expected $ARGOS_ROOT/bin/ollama-linux or ollama on PATH." >&2
  exit 1
fi

LAUNCHER_LOG="$ARGOS_ROOT/logs/launcher.log"
OLLAMA_LOG="$ARGOS_ROOT/logs/ollama.log"
NEXT_LOG="$ARGOS_ROOT/logs/next.log"

# --- Log rotation (Phase 1) ---------------------------------
# Roll each log if it exceeds 10 MB. Keep 3 generations (.1 .2 .3).
# Done before daemons start so the rename can succeed (no open handles).
rotate_log() {
  local log="$1"
  [ -f "$log" ] || return 0
  local size
  size=$(wc -c <"$log" 2>/dev/null | tr -d ' ')
  [ -n "$size" ] && [ "$size" -lt 10485760 ] && return 0
  [ -f "$log.3" ] && rm -f "$log.3"
  [ -f "$log.2" ] && mv "$log.2" "$log.3"
  [ -f "$log.1" ] && mv "$log.1" "$log.2"
  mv "$log" "$log.1"
}
rotate_log "$LAUNCHER_LOG"
rotate_log "$OLLAMA_LOG"
rotate_log "$NEXT_LOG"

echo ""
echo " ARGOS — local-first AI workstation"
echo " --------------------------------------------------------"
echo " ARGOS_ROOT  $ARGOS_ROOT"
echo " Next.js     $NEXTJS_DIR"
echo " Ollama      $OLLAMA_BIN"
echo " Ports       Ollama $OLLAMA_PORT  Next.js $NEXT_PORT"
echo " Logs        $ARGOS_ROOT/logs/"
echo ""

OLLAMA_PID=""
NEXT_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  if [ -n "$NEXT_PID" ] && kill -0 "$NEXT_PID" 2>/dev/null; then
    kill -TERM "$NEXT_PID" 2>/dev/null || true
  fi
  if [ -n "$OLLAMA_PID" ] && kill -0 "$OLLAMA_PID" 2>/dev/null; then
    kill -TERM "$OLLAMA_PID" 2>/dev/null || true
  fi
  sleep 1
  if [ -n "$NEXT_PID" ] && kill -0 "$NEXT_PID" 2>/dev/null; then
    kill -KILL "$NEXT_PID" 2>/dev/null || true
  fi
  if [ -n "$OLLAMA_PID" ] && kill -0 "$OLLAMA_PID" 2>/dev/null; then
    kill -KILL "$OLLAMA_PID" 2>/dev/null || true
  fi
  echo "Done."
}
trap cleanup INT TERM EXIT

echo "[1/4] Starting Ollama on 127.0.0.1:$OLLAMA_PORT..."
"$OLLAMA_BIN" serve >>"$OLLAMA_LOG" 2>&1 &
OLLAMA_PID=$!

for i in $(seq 1 30); do
  if curl -fs --max-time 2 "http://127.0.0.1:$OLLAMA_PORT/api/tags" >/dev/null 2>&1; then
    break
  fi
  echo "   ... waiting ($i/30)"
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[ERROR] Ollama did not respond within 30s. See $OLLAMA_LOG" >&2
    exit 1
  fi
done
echo "[2/4] Ollama ready on port $OLLAMA_PORT"

echo "[3/4] Starting Next.js on 127.0.0.1:$NEXT_PORT..."
(cd "$NEXTJS_DIR" && node node_modules/next/dist/bin/next start -p "$NEXT_PORT" >>"$NEXT_LOG" 2>&1) &
NEXT_PID=$!

for i in $(seq 1 30); do
  if curl -fs --max-time 2 "http://127.0.0.1:$NEXT_PORT" >/dev/null 2>&1; then
    break
  fi
  echo "   ... waiting ($i/30)"
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[ERROR] Next.js did not respond within 30s. See $NEXT_LOG" >&2
    exit 1
  fi
done

if [ -n "${DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
  echo "[4/4] ARGOS ready — opening browser at http://127.0.0.1:$NEXT_PORT"
  xdg-open "http://127.0.0.1:$NEXT_PORT" 2>/dev/null || true
else
  echo "[4/4] ARGOS ready — no display detected"
  echo ""
  echo "  Headless mode: open this URL from another machine on this host:"
  echo "    http://127.0.0.1:$NEXT_PORT"
  echo "  (substitute the host's LAN IP if accessing from a different box)"
fi


# ============================================================
#  Tool integration (post-Phase-1 patch) — cross-platform note
#
#  The tool auto-start scripts (tools/oculus/start.bat, tools/superagi/
#  start.bat) are Windows-only in this release. On macOS/Linux:
#    - the ToolsDock in the UI works the same (polls /api/tools/status)
#    - operator can boot tools manually: cd to the tool dir + docker compose up -d
#  See tools/registry.json for the canonical tool list + ports.
#
#  Honest cross-platform stance: rather than fabricate .sh equivalents
#  for the Windows-specific start/stop logic, this block exists as a
#  cross-platform doctrine marker. Add real .sh tool spawns here if/when
#  Mac/Linux operator need is real.
# ============================================================

echo ""
echo " ARGOS is running."
echo " Press Ctrl-C to shut down ARGOS cleanly."
echo ""

wait $NEXT_PID
