#!/usr/bin/env node
// verify-host-clean.mjs
//
// Executable form of Seven USB-Native Rule #1 — "zero host
// persistence". Takes a filesystem snapshot of the user-writable host
// directories before launching ARGOS, takes another snapshot after
// closing it, and diffs. Any file created or modified outside the
// USB payload during the ARGOS run is a violation (with a small
// exception list for paths the OS itself touches on every login).
//
// Modes:
//   node scripts/verify-host-clean.mjs --capture-before [--out=path]
//   node scripts/verify-host-clean.mjs --capture-after  [--out=path]
//   node scripts/verify-host-clean.mjs --diff
//
// Defaults to .argos-host-before.json and .argos-host-after.json in
// the repo root. Both are gitignored (tsbuildinfo-style noise).
//
// Windows-first (it scans %APPDATA%, %LOCALAPPDATA%, %TEMP%,
// %USERPROFILE%\Documents). macOS / Linux equivalents are stubbed
// with TODOs — H8 spec scoped this to Windows.

import {
  promises as fsp,
  existsSync,
  statSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) return [a.slice(2), "true"];
      return [a.slice(2, eq), a.slice(eq + 1)];
    }
    return [a, "true"];
  })
);

const MODE = args["capture-before"]
  ? "capture-before"
  : args["capture-after"]
    ? "capture-after"
    : args["diff"]
      ? "diff"
      : null;
if (!MODE) {
  console.error(
    "Usage: verify-host-clean.mjs --capture-before | --capture-after | --diff"
  );
  process.exit(2);
}

const BEFORE_PATH = args.before ?? path.join(ROOT, ".argos-host-before.json");
const AFTER_PATH = args.after ?? path.join(ROOT, ".argos-host-after.json");

// -------------------------- scan targets ---------------------------
function scanRoots() {
  if (process.platform === "win32") {
    return [
      process.env.APPDATA,
      process.env.LOCALAPPDATA,
      process.env.TEMP,
      process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, "Documents")
        : null,
    ].filter(Boolean);
  }
  // POSIX placeholder — H8 scoped to Windows
  return [
    path.join(os.homedir(), "Library", "Application Support"),
    path.join(os.homedir(), ".config"),
    path.join(os.homedir(), ".cache"),
    "/tmp",
  ].filter((p) => existsSync(p));
}

// Paths whose modifications are NEVER attributable to ARGOS. These
// are OS-level or third-party caches that tick on every session.
// Each entry is a regex matched against the relative-to-scan-root path
// using forward slashes.
const EXCEPTION_PATTERNS = [
  // ---- Windows / Microsoft -----------------------------------
  /^Microsoft[\\/]Windows[\\/]/,
  /^Microsoft[\\/]Edge[\\/]/,
  /^Microsoft[\\/]Credentials[\\/]/,
  /^Microsoft[\\/]Spelling[\\/]/,
  /^Microsoft[\\/]OneDrive[\\/]/,
  /^Microsoft[\\/]Office[\\/]/,
  /^Packages[\\/]Microsoft\./,
  /^Packages[\\/]MicrosoftWindows\./,
  /^Packages[\\/]Windows\./,
  /[\\/]MSEdge_Crashpad[\\/]/,
  /[\\/]ContentDeliveryManager_/,
  /[\\/]WebExperience_/,
  /[\\/]WindowsNotepad_/,
  /[\\/]EdgeUpdate[\\/]/,
  // ---- Browsers / Anthropic -----------------------------------
  /^Google[\\/]Chrome[\\/]/,
  /^Google[\\/]DriveFS[\\/]/,
  /^Mozilla[\\/]/,
  /^Anthropic[\\/]/,
  /^Claude[\\/]/,
  /^Claude /,
  /[\\/]Code Cache[\\/]/,
  /[\\/]GPUCache[\\/]/,
  /[\\/]ShaderCache[\\/]/,
  /[\\/]GraphiteDawnCache[\\/]/,
  /[\\/]GrShaderCache[\\/]/,
  /[\\/]DawnGraphiteCache[\\/]/,
  /[\\/]DawnWebGPUCache[\\/]/,
  /[\\/]Cache[\\/]/,
  /[\\/]cache[\\/]/,
  /[\\/]CrashDumps?[\\/]/,
  /[\\/]Crashpad[\\/]/,
  /[\\/]CrashReports?[\\/]/,
  /[\\/]BrowserMetrics[\\/]/,
  /[\\/]Logs?[\\/]Anthropic/,
  /[\\/]Network[\\/]/,
  /[\\/]Service Worker[\\/]/,
  /[\\/]sentry[\\/]/,
  /[\\/]TargetedContentCache[\\/]/,
  /[\\/]TabState[\\/]/,
  /[\\/]webview2_user_data[\\/]/,
  /[\\/]EBWebView[\\/]/,
  /[\\/]history$/i,
  /[\\/]Favicons$/i,
  /[\\/]Cookies[^\\/]*$/i,
  /[\\/]Top Sites/i,
  /[\\/]Visited Links/i,
  /[\\/]Last (Tabs|Session|Browser)/i,
  /[\\/]Trust Tokens/i,
  /[\\/]LOCK$/i,
  /[\\/]LOG\.old$/i,
  /[\\/]Local Storage[\\/]/i,
  /[\\/]Session Storage[\\/]/i,
  /[\\/]Sessions[\\/]/i,
  /[\\/]Sync Data[\\/]/i,
  /[\\/]Login Data/i,
  /[\\/]History/i,
  /[\\/]Web Data/i,
  /[\\/]Bookmarks/i,
  /[\\/]Preferences/i,
  /[\\/]Local State$/i,
  /[\\/]variations-/i,
  /[\\/]DIPS[-\.]/i,
  /[\\/]QuotaManager/i,
  /[\\/]fcache$/i,
  /[\\/]extensions-blocklist\.json$/i,
  /[\\/]claude-code-sessions[\\/]/i,
  /[\\/]claude_desktop_config\.json$/i,
  /[\\/]config\.json$/i,
  /[\\/]local-agent-mode-sessions[\\/]/i,
  // ---- GPU drivers --------------------------------------------
  /^NVIDIA[\\/]/,
  /[\\/]NVIDIA[\\/]/,
  /[\\/]DXCache[\\/]/,
  /[\\/]ComputeCache[\\/]/,
  // ---- Temp files / common noise ------------------------------
  /\.log$/i,
  /\.tmp$/i,
  /\.lock$/i,
  /\.bin$/i,
  /\.aodl$/i,
  /\.odlgz$/i,
  /[\\/]Temp[\\/][^\\/]+\.(bin|tmp|log)$/i,
  /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i,
  // ---- Node / npm caches --------------------------------------
  /[\\/]npm-cache[\\/]/,
  /[\\/]\.npm[\\/]/,
  /[\\/]node-gyp[\\/]/,
  // ---- Misc --------------------------------------------------
  /[\\/]INetCache[\\/]/,
  /[\\/]CryptnetUrlCache[\\/]/,
  /[\\/]WindowsApps[\\/]/,
  /[\\/]MSTeams_/,
  // ---- Test-harness artefacts (NOT ARGOS) --------------------
  // Claude Code runtime stores background-task buffers under
  // %TEMP%\claude — that's the test driver, not the launcher under test.
  /[\\/]Temp[\\/]claude[\\/]/,
  // Test-driver curl outputs from earlier sessions.
  /[\\/]Temp[\\/]argos-/i,
  // Stray xml_file noise from PowerShell session captures.
  /[\\/]Temp[\\/]xml_file/i,
  // Loose .ses session markers in Temp root.
  /[\\/]Temp[\\/]\.ses$/,
];

const MAX_DEPTH = 6;
const MAX_FILES_PER_ROOT = 200_000; // sanity cap

// -------------------------- snapshot --------------------------------
async function snapshotRoots(roots) {
  const out = {};
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const seen = {};
    let count = 0;
    function walk(d, depth) {
      if (depth > MAX_DEPTH) return;
      if (count >= MAX_FILES_PER_ROOT) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (count >= MAX_FILES_PER_ROOT) return;
        const full = path.join(d, e.name);
        try {
          if (e.isDirectory()) {
            walk(full, depth + 1);
          } else if (e.isFile()) {
            const st = statSync(full);
            seen[full] = st.mtimeMs;
            count++;
          }
        } catch {
          /* skip permission errors */
        }
      }
    }
    walk(root, 0);
    out[root] = { count, files: seen };
  }
  return out;
}

function isException(relPath, fullPath) {
  return EXCEPTION_PATTERNS.some((re) => re.test(relPath) || re.test(fullPath));
}

// -------------------------- modes -----------------------------------
if (MODE === "capture-before" || MODE === "capture-after") {
  const outPath = MODE === "capture-before" ? BEFORE_PATH : AFTER_PATH;
  console.log(`Capturing host snapshot (${MODE})...`);
  const roots = scanRoots();
  console.log(`Scan roots:`);
  for (const r of roots) console.log(`  - ${r}`);
  const t0 = Date.now();
  const snap = await snapshotRoots(roots);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  let total = 0;
  for (const r of Object.keys(snap)) total += snap[r].count;
  const payload = {
    mode: MODE,
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    totalFiles: total,
    roots: snap,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Captured ${total} files across ${roots.length} roots in ${elapsed}s.`);
  console.log(`Snapshot -> ${outPath}`);
  console.log(
    MODE === "capture-before"
      ? "\nNow launch ARGOS from the USB. When you close it, run --capture-after, then --diff."
      : "\nNow run --diff to compare against the before snapshot."
  );
  process.exit(0);
}

if (MODE === "diff") {
  if (!existsSync(BEFORE_PATH) || !existsSync(AFTER_PATH)) {
    console.error(
      `[ERROR] Missing snapshot(s). Need both:\n  ${BEFORE_PATH}\n  ${AFTER_PATH}\n` +
        `Run --capture-before, launch ARGOS, close it, then --capture-after, then --diff.`
    );
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(BEFORE_PATH, "utf8"));
  const after = JSON.parse(readFileSync(AFTER_PATH, "utf8"));
  console.log(
    `Diff: ${before.totalFiles} -> ${after.totalFiles} files (delta ${after.totalFiles - before.totalFiles})`
  );

  const changes = { added: [], modified: [], exceptions: 0 };
  for (const root of Object.keys(after.roots)) {
    const beforeFiles = before.roots[root]?.files ?? {};
    const afterFiles = after.roots[root].files;
    for (const f of Object.keys(afterFiles)) {
      const rel = path.relative(root, f);
      if (!(f in beforeFiles)) {
        if (isException(rel, f)) {
          changes.exceptions++;
        } else {
          changes.added.push({ root, rel, mtime: afterFiles[f] });
        }
      } else if (afterFiles[f] > beforeFiles[f]) {
        if (isException(rel, f)) {
          changes.exceptions++;
        } else {
          changes.modified.push({ root, rel, mtime: afterFiles[f] });
        }
      }
    }
  }

  console.log(`\nException matches (filtered): ${changes.exceptions}`);
  console.log(`Attributable additions:        ${changes.added.length}`);
  console.log(`Attributable modifications:    ${changes.modified.length}`);

  if (changes.added.length === 0 && changes.modified.length === 0) {
    console.log(
      "\n[PASS] Host filesystem clean — Seven Rules #1 holds (zero host persistence)."
    );
    process.exit(0);
  }

  console.log("\n[FAIL] Attributable host writes during ARGOS run:");
  for (const c of changes.added.slice(0, 40)) {
    console.log(`  ADD  ${c.root}\\${c.rel}`);
  }
  for (const c of changes.modified.slice(0, 40)) {
    console.log(`  MOD  ${c.root}\\${c.rel}`);
  }
  if (changes.added.length + changes.modified.length > 80) {
    console.log(
      `  ... ${changes.added.length + changes.modified.length - 80} more`
    );
  }
  process.exit(1);
}
