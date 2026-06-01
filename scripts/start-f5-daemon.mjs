#!/usr/bin/env node
// start-f5-daemon.mjs — Phase 7-C: start the persistent F5-TTS daemon.
//
// Loads the F5 model ONCE and serves synthesis over 127.0.0.1:7880 so the
// Bartimaeus voice clone responds in ~5s instead of the ~20s CLI cold-load.
// Run this on ARGOS boot (launcher) or manually: `npm run voice:f5-daemon`.
//
// Resolves the F5 venv python from ARGOS_F5_HOME (default the dev path) and
// the daemon script from ARGOS_ROOT/tools/voice/f5-daemon/server.py. Exits
// cleanly (non-zero) with a clear message if F5 isn't installed — the
// dispatcher/voice path still works (it falls back to the CLI, then Piper).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
// Default derived from home dir (no hardcoded absolute path — USB-native Rule 1).
const F5_HOME = process.env.ARGOS_F5_HOME || path.join(os.homedir(), "dev", "f5-tts");
const ARGOS_ROOT = process.env.ARGOS_ROOT || process.cwd();
const PORT = process.env.ARGOS_F5_PORT || "7880";
const DEVICE = process.env.ARGOS_F5_DEVICE || "cuda";

const py = path.join(F5_HOME, "venv", IS_WIN ? "Scripts" : "bin", IS_WIN ? "python.exe" : "python");
const script = path.join(ARGOS_ROOT, "tools", "voice", "f5-daemon", "server.py");

if (!existsSync(py)) {
  console.error(`[start-f5-daemon] F5 venv python not found: ${py}`);
  console.error("  Install F5-TTS or set ARGOS_F5_HOME. Voice falls back to CLI/Piper.");
  process.exit(1);
}
if (!existsSync(script)) {
  console.error(`[start-f5-daemon] daemon script not found: ${script}`);
  process.exit(1);
}

console.log(`[start-f5-daemon] ${py}\n  ${script}\n  port=${PORT} device=${DEVICE} ARGOS_ROOT=${ARGOS_ROOT}`);
const child = spawn(py, [script], {
  stdio: "inherit",
  env: { ...process.env, ARGOS_ROOT, ARGOS_F5_PORT: PORT, ARGOS_F5_DEVICE: DEVICE },
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  console.error("[start-f5-daemon] spawn failed:", e.message);
  process.exit(1);
});
