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
export OLLAMA_MODELS="$ARGOS_ROOT/models"
export TMPDIR="$ARGOS_ROOT/tmp"

mkdir -p "$ARGOS_ROOT/logs" "$ARGOS_ROOT/tmp"

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

echo ""
echo " ARGOS — local-first AI workstation"
echo " --------------------------------------------------------"
echo " ARGOS_ROOT  $ARGOS_ROOT"
echo " Next.js     $NEXTJS_DIR"
echo " Ollama      $OLLAMA_BIN"
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

echo "[1/4] Starting Ollama on 127.0.0.1:11434..."
"$OLLAMA_BIN" serve >>"$OLLAMA_LOG" 2>&1 &
OLLAMA_PID=$!

for i in $(seq 1 30); do
  if curl -fs --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  echo "   ... waiting ($i/30)"
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[ERROR] Ollama did not respond within 30s. See $OLLAMA_LOG" >&2
    exit 1
  fi
done
echo "[2/4] Ollama ready on port 11434"

echo "[3/4] Starting Next.js on 127.0.0.1:7799..."
(cd "$NEXTJS_DIR" && node node_modules/next/dist/bin/next start -p 7799 >>"$NEXT_LOG" 2>&1) &
NEXT_PID=$!

for i in $(seq 1 30); do
  if curl -fs --max-time 2 http://127.0.0.1:7799 >/dev/null 2>&1; then
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
  echo "[4/4] ARGOS ready — opening browser at http://127.0.0.1:7799"
  xdg-open "http://127.0.0.1:7799" 2>/dev/null || true
else
  echo "[4/4] ARGOS ready — no display detected"
  echo ""
  echo "  Headless mode: open this URL from another machine on this host:"
  echo "    http://127.0.0.1:7799"
  echo "  (substitute the host's LAN IP if accessing from a different box)"
fi

echo ""
echo " ARGOS is running."
echo " Press Ctrl-C to shut down ARGOS cleanly."
echo ""

wait $NEXT_PID
