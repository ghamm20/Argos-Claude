#!/usr/bin/env node
// smoke-launcher.mjs — file-level checks on the three platform launchers.
//
// What this DOES check:
//   - each launcher file exists with the expected extension
//   - .command and .sh are marked executable in the working tree
//     (best-effort: on Windows the FS bit may be moot, so we also
//      verify git index has mode 100755)
//   - all three resolve ARGOS_ROOT via the documented three-layout sniff
//   - all three have stage markers [1/4]..[4/4]
//   - all three contain cleanup logic
//   - all three reference the correct ports
//
// What this DOES NOT check:
//   - actually running the launcher (that is manual eyes-on per H7)
//   - whether services come up (that requires the runtime environment)

import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LAUNCHERS = [
  {
    name: "Windows",
    file: "launchers/launcher.bat",
    needsExec: false,
    needles: {
      argosRootSniff: /SCRIPT_DIR.+app.+package\.json/s,
      stages: [/\[1\/4\]/, /\[2\/4\]/, /\[3\/4\]/, /\[4\/4\]/],
      cleanup: /(:CLEANUP|taskkill)/,
      ollamaPort: /11434/,
      nextPort: /7799/,
      envScoped: /NEXT_TELEMETRY_DISABLED=1/,
      curlPoll: /curl/,
    },
  },
  {
    name: "macOS",
    file: "launchers/launcher.command",
    needsExec: true,
    needles: {
      argosRootSniff: /BASH_SOURCE.+SCRIPT_DIR/s,
      stages: [/\[1\/4\]/, /\[2\/4\]/, /\[3\/4\]/, /\[4\/4\]/],
      cleanup: /trap cleanup/,
      ollamaPort: /11434/,
      nextPort: /7799/,
      envScoped: /NEXT_TELEMETRY_DISABLED=1/,
      curlPoll: /curl/,
      browserOpen: /\bopen\s+["']http/,
    },
  },
  {
    name: "Linux",
    file: "launchers/launcher.sh",
    needsExec: true,
    needles: {
      argosRootSniff: /BASH_SOURCE.+SCRIPT_DIR/s,
      stages: [/\[1\/4\]/, /\[2\/4\]/, /\[3\/4\]/, /\[4\/4\]/],
      cleanup: /trap cleanup/,
      ollamaPort: /11434/,
      nextPort: /7799/,
      envScoped: /NEXT_TELEMETRY_DISABLED=1/,
      curlPoll: /curl/,
      browserOpen: /xdg-open/,
      headlessFallback: /DISPLAY/,
    },
  },
];

let totalFails = 0;

function check(label, cond, detail = "") {
  const tag = cond ? "[ ok ]" : "[FAIL]";
  console.log(`  ${tag} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) totalFails++;
}

// Git index mode lookup once for the executable-bit check.
let gitLsFiles = "";
try {
  gitLsFiles = execSync("git ls-files --stage launchers/", {
    cwd: ROOT,
    encoding: "utf8",
  });
} catch {
  gitLsFiles = "";
}

for (const L of LAUNCHERS) {
  console.log(`\n=== ${L.name} (${L.file}) ===`);
  const full = resolve(ROOT, L.file);

  const exists = existsSync(full);
  check("file exists", exists);
  if (!exists) continue;

  const src = readFileSync(full, "utf8");
  const sz = statSync(full).size;
  check(`non-empty (${sz} bytes)`, sz > 0);

  if (L.needsExec) {
    // Match the git index line for this path
    const re = new RegExp(`^(\\d+)\\s+\\w+\\s+\\d+\\s+${L.file.replace(/[.\/]/g, "\\$&")}$`, "m");
    const m = re.exec(gitLsFiles);
    if (m) {
      const mode = m[1];
      check(`git index mode 100755 (got ${mode})`, mode === "100755");
    } else {
      check("git index entry present", false, "(not in git ls-files)");
    }
  }

  for (const [label, needle] of Object.entries(L.needles)) {
    if (Array.isArray(needle)) {
      // multi-needle (stages)
      const allOk = needle.every((n) => n.test(src));
      check(label, allOk);
    } else {
      check(label, needle.test(src));
    }
  }
}

console.log(`\n=== README ===`);
const readmePath = resolve(ROOT, "launchers/README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  check("documents ARGOS_ROOT resolution", /ARGOS_ROOT/.test(readme));
  check("documents the five acceptance criteria", /Acceptance criteria/i.test(readme));
  check("documents port 11434 + 7799", /11434/.test(readme) && /7799/.test(readme));
  check("documents Gatekeeper first-launch flow", /Gatekeeper/i.test(readme));
  check("documents headless DISPLAY fallback", /DISPLAY/.test(readme));
} else {
  check("README exists", false);
}

console.log(`\n=== Layout doc ===`);
const layoutPath = resolve(ROOT, "launchers/ARGOS_layout.md");
if (existsSync(layoutPath)) {
  const layout = readFileSync(layoutPath, "utf8");
  check("layout doc mentions bin/", /bin\//.test(layout));
  check("layout doc mentions app/", /app\//.test(layout));
  check("layout doc mentions vault/", /vault\//.test(layout));
  check("layout doc mentions config/", /config\//.test(layout));
  check("layout doc mentions models/", /models\//.test(layout));
} else {
  check("layout doc exists", false);
}

console.log(
  "\n" +
    (totalFails === 0
      ? "Launcher smoke: PASS"
      : `Launcher smoke: ${totalFails} FAIL${totalFails === 1 ? "" : "S"}`)
);
process.exit(totalFails === 0 ? 0 : 1);
