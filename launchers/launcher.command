#!/bin/bash
# ============================================================
#  ARGOS USB-native launcher (macOS)
#
#  See launchers/README.md for the design and the five-point
#  acceptance contract.
#
#  First-launch Gatekeeper note: right-click in Finder -> Open
#  to bypass the unverified-developer prompt. Subsequent launches
#  work normally.
# ============================================================

set -eo pipefail

# --- Resolve script dir + layout sniff ----------------------
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
  echo "Expected one of:" >&2
  echo "  \$SCRIPT_DIR/app/package.json   (post-H8 USB layout)" >&2
  echo "  \$SCRIPT_DIR/package.json       (launcher at repo root)" >&2
  echo "  \$SCRIPT_DIR/../package.json    (pre-H8 dev with launchers/ subdir)" >&2
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

export ARGOS_ROOT
export NEXT_TELEMETRY_DISABLED=1
# Default to the USB-payload location, but respect caller-provided override
# (smoke tests, devs pointing at host models).
export OLLAMA_MODELS="${OLLAMA_MODELS:-$ARGOS_ROOT/models}"
export TMPDIR="$ARGOS_ROOT/tmp"
# Daemon and app share OLLAMA_HOST so they stay in sync (lib/ollama-config.ts).
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

mkdir -p "$ARGOS_ROOT/logs" "$ARGOS_ROOT/tmp"

# --- Locate Ollama binary -----------------------------------
OLLAMA_BIN=""
if [ -x "$ARGOS_ROOT/bin/ollama-darwin" ]; then
  OLLAMA_BIN="$ARGOS_ROOT/bin/ollama-darwin"
elif [ -x "$ARGOS_ROOT/bin/ollama" ]; then
  OLLAMA_BIN="$ARGOS_ROOT/bin/ollama"
elif command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="$(command -v ollama)"
fi
if [ -z "$OLLAMA_BIN" ]; then
  echo "[ERROR] Ollama binary not found." >&2
  echo "Expected one of:" >&2
  echo "  $ARGOS_ROOT/bin/ollama-darwin   (bundled — H8 will populate)" >&2
  echo "  $ARGOS_ROOT/bin/ollama" >&2
  echo "  any ollama on PATH" >&2
  read -n 1 -s -r -p "Press any key to close..."
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

# ====== Stage 1/4: start Ollama =============================
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

# ====== Stage 3/4: start Next.js prod =======================
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
echo "[4/4] ARGOS ready — opening browser at http://127.0.0.1:7799"
open "http://127.0.0.1:7799" 2>/dev/null || true

echo ""
echo " ARGOS is running."
echo " Press Ctrl-C in this Terminal window to shut down ARGOS cleanly."
echo " (Closing the window also runs the cleanup trap.)"
echo ""

wait $NEXT_PID
