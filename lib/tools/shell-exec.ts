// lib/tools/shell-exec.ts — T16 Shell Command Execution
// (approval + restore; WHITELIST ONLY).
//
// HARD whitelist — anything not on the list is denied before approval. No
// shell metacharacters (no chaining/redirect/substitution). 30s hard timeout.

import { spawn } from "node:child_process";
import { toolOk, toolErr, type ToolExecute } from "./types";

export const ID = "shell_exec";

/** The ONLY commands ARGOS will run. Matched as a prefix on the trimmed,
 *  lower-cased command line. */
export const WHITELIST = [
  "ipconfig",
  "ping",
  "netstat",
  "tasklist",
  "systeminfo",
  "dir",
  "whoami",
  "get-process",
  "get-service",
  "ollama list",
  "ollama ps",
];

// No command chaining / redirection / substitution — keeps a whitelisted
// prefix from smuggling a second command.
const FORBIDDEN = /[;&|`$><\n\r(){}]/;

const TIMEOUT_MS = 30_000;

export function validate(params: Record<string, unknown>): { ok: boolean; error?: string } {
  const cmd = String(params.command ?? "").trim();
  if (!cmd) return { ok: false, error: "command is required" };
  if (FORBIDDEN.test(cmd)) {
    return { ok: false, error: "command contains forbidden shell metacharacters" };
  }
  const lower = cmd.toLowerCase();
  const matched = WHITELIST.find((w) => lower === w || lower.startsWith(w + " "));
  if (!matched) {
    return {
      ok: false,
      error: `command not on whitelist: "${cmd.split(/\s+/)[0]}". Allowed: ${WHITELIST.join(", ")}`,
    };
  }
  return { ok: true };
}

export const execute: ToolExecute = async (params) => {
  const cmd = String(params.command ?? "").trim();
  const v = validate(params);
  if (!v.ok) return toolErr(ID, v.error ?? "rejected");

  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    // PowerShell on Windows handles dir / Get-* / ollama uniformly; /bin/sh
    // elsewhere. The command was already whitelisted + metachar-screened.
    const child = isWin
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
          windowsHide: true,
        })
      : spawn("/bin/sh", ["-c", cmd]);

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(toolErr(ID, `spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve(toolErr(ID, `command timed out after ${TIMEOUT_MS / 1000}s`));
        return;
      }
      resolve(
        toolOk(ID, `\`${cmd}\` exited ${code}`, {
          data: {
            command: cmd,
            exitCode: code,
            stdout: stdout.slice(0, 8000),
            stderr: stderr.slice(0, 4000),
          },
        })
      );
    });
  });
};
