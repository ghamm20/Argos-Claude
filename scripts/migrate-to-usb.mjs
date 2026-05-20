#!/usr/bin/env node
// migrate-to-usb.mjs
//
// Copies the ARGOS payload to a target directory matching the layout
// documented in launchers/ARGOS_layout.md.
//
// Usage:
//   node scripts/migrate-to-usb.mjs --target=E:\\ARGOS
//   node scripts/migrate-to-usb.mjs --target=/Volumes/PNY/ARGOS
//   node scripts/migrate-to-usb.mjs --target=...  --dry-run
//
// Env override:
//   USB_TARGET=E:\\ARGOS  node scripts/migrate-to-usb.mjs
//
// Drive-identity verification (v2 hardening, filed in
// methodology/corrections.md after the H8.5 drive-letter incident
// where Windows reassigned D: between runs and 13 GB was written to
// the wrong drive):
//   --expect-label=PNY_PRO_ELITEV3       (Windows only via Get-Volume)
//   --expect-drivetype=Removable         (Windows only)
//
// Post-migration smoke (v2 hardening, filed after the H8.5 silent
// ollama-serve failure caused by missing lib/ runtime):
//   The script invokes `<target>/bin/ollama.exe --version` with a
//   5s timeout after the copy. Mismatch with system binary or
//   non-zero exit prints a WARN but does not fail the migration.
//
// Refuses to write if:
//   - --target is missing
//   - target equals the source repo root (would copy onto self)
//   - .next/ is missing (must run "npm run build" first)
//   - target parent does not exist
//   - --expect-label is given and Get-Volume reports a different label
//   - --expect-drivetype is given and Get-Volume reports a different type
//   - --i-acknowledge-overwrite is required when target dir already
//     contains an ARGOS payload (any of: launcher.bat, app/.next,
//     models/manifests)

import {
  promises as fsp,
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// -------------------------- args ------------------------------------
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
const TARGET = args.target ?? process.env.USB_TARGET ?? null;
const DRY_RUN = args["dry-run"] === "true";
const ACK_OVERWRITE = args["i-acknowledge-overwrite"] === "true";
const SKIP_MODELS = args["skip-models"] === "true";
const EXPECT_LABEL = args["expect-label"] ?? null;
const EXPECT_DRIVETYPE = args["expect-drivetype"] ?? null;
const SKIP_SMOKE = args["skip-smoke"] === "true";

function die(msg, code = 1) {
  console.error(`\n[ERROR] ${msg}\n`);
  process.exit(code);
}

if (!TARGET) {
  die(
    "Missing --target. Example:\n  node scripts/migrate-to-usb.mjs --target=E:\\ARGOS"
  );
}

const ABS_TARGET = path.resolve(TARGET);
if (path.normalize(ABS_TARGET) === path.normalize(ROOT)) {
  die("Refusing to migrate onto the source repo root.");
}
const parentDir = path.dirname(ABS_TARGET);
if (!existsSync(parentDir)) {
  die(`Parent of --target does not exist: ${parentDir}`);
}

// Pre-flight: drive identity check (Windows only, no-op elsewhere).
// Stops the H8.5 wrong-drive failure mode dead.
{
  const probe = verifyTargetDrive(ABS_TARGET, EXPECT_LABEL, EXPECT_DRIVETYPE);
  if (!probe.ok) {
    die(`Drive-identity pre-flight failed:\n  ${probe.error}`);
  }
  if (probe.skipped) {
    console.log(`[pre-flight] drive check: ${probe.skipped}`);
  } else {
    console.log(
      `[pre-flight] drive ${probe.drive}: label='${probe.label}', DriveType='${probe.driveType}' — OK`
    );
  }
}

// -------------------------- helpers ---------------------------------
function fmtMB(b) {
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
function fmtGB(b) {
  return `${(b / (1024 ** 3)).toFixed(2)} GB`;
}

// verifyTargetDrive — Windows-only Get-Volume probe.
//
// Pre-flight check filed as v2 hardening in corrections.md after the
// H8.5 drive-letter incident: an ejected/reinserted PNY came back at
// F: while D: was reclaimed by a different fixed drive, and the
// follow-up robocopy wrote 13 GB to the wrong place. Drive letters
// are not stable identity; labels + DriveType are.
//
// On non-Windows, this is a no-op (skips with a note) — operators
// on macOS/Linux use mount points like /Volumes/PNY which are
// self-identifying.
function verifyTargetDrive(absTarget, expectLabel, expectDriveType) {
  if (!expectLabel && !expectDriveType) return { ok: true, skipped: "no expectation specified" };
  if (process.platform !== "win32") {
    return { ok: true, skipped: "non-windows platform — Get-Volume not applicable" };
  }
  // Extract drive letter from the absolute target path
  const match = absTarget.match(/^([A-Za-z]):[\\/]/);
  if (!match) {
    return { ok: false, error: `cannot extract drive letter from target: ${absTarget}` };
  }
  const drive = match[1].toUpperCase();
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$v = Get-Volume -DriveLetter ${drive} -ErrorAction SilentlyContinue; if (-not $v) { Write-Output 'NOTFOUND'; exit 0 } else { Write-Output ("LABEL=" + $v.FileSystemLabel); Write-Output ("DRIVETYPE=" + $v.DriveType) }`,
    ],
    { encoding: "utf8", timeout: 10000 }
  );
  if (ps.status !== 0) {
    return { ok: false, error: `Get-Volume failed (status ${ps.status}): ${ps.stderr || ps.stdout}` };
  }
  const out = (ps.stdout || "").trim();
  if (out === "NOTFOUND") {
    return { ok: false, error: `Get-Volume found no volume at ${drive}: — drive missing or unmounted` };
  }
  const labelLine = out.split(/\r?\n/).find((l) => l.startsWith("LABEL="));
  const dtLine = out.split(/\r?\n/).find((l) => l.startsWith("DRIVETYPE="));
  const actualLabel = labelLine ? labelLine.slice("LABEL=".length).trim() : "";
  const actualDt = dtLine ? dtLine.slice("DRIVETYPE=".length).trim() : "";
  if (expectLabel && actualLabel !== expectLabel) {
    return {
      ok: false,
      error: `Drive ${drive}: label mismatch — expected '${expectLabel}', got '${actualLabel}'. Refusing to write. Pass --expect-label='${actualLabel}' to override (or eject/reinsert and confirm letter).`,
    };
  }
  if (expectDriveType && actualDt !== expectDriveType) {
    return {
      ok: false,
      error: `Drive ${drive}: DriveType mismatch — expected '${expectDriveType}', got '${actualDt}'. Refusing to write.`,
    };
  }
  return { ok: true, label: actualLabel, driveType: actualDt, drive };
}

// smokePostMigration — sanity-check the copied Ollama binary.
//
// Filed as v2 hardening after H8.5 silent-failure: ollama.exe runs
// in client mode without lib/ but `serve` needs the runtime DLLs.
// A 5-second timeout-bounded --version check is the cheapest signal
// that bin/ was copied with its runtime libs intact.
function smokePostMigration(absTarget) {
  if (process.platform !== "win32") {
    return { ok: true, skipped: "non-windows: ollama smoke deferred to launcher" };
  }
  const bin = path.join(absTarget, "bin", "ollama.exe");
  if (!existsSync(bin)) {
    return { ok: false, error: `bin/ollama.exe not found at ${bin}` };
  }
  const r = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  if (r.error) {
    return { ok: false, error: `spawn failed: ${r.error.message}` };
  }
  if (r.status !== 0 && r.status !== null) {
    return { ok: false, error: `exit ${r.status}: ${(r.stderr || r.stdout || "").trim()}` };
  }
  // Note: --version may also print a "could not connect to a running Ollama
  // instance" warning when no daemon is up. That's expected and OK.
  const out = (r.stdout || r.stderr || "").trim();
  return { ok: true, output: out.split(/\r?\n/).slice(0, 3).join(" | ") };
}

async function dirSize(dir) {
  let total = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* skip */
        }
      }
    }
  }
  await walk(dir);
  return total;
}

async function ensureDir(p) {
  if (DRY_RUN) {
    console.log(`  [dry-run] mkdir ${p}`);
    return;
  }
  await fsp.mkdir(p, { recursive: true });
}

async function copyFile(src, dst) {
  if (DRY_RUN) return;
  await fsp.copyFile(src, dst);
}

async function copyTree(src, dst, opts = {}) {
  const { exclude = [], onFile } = opts;
  const stat = statSync(src);
  if (!stat.isDirectory()) {
    if (exclude.some((rx) => rx.test(src))) return 0;
    await ensureDir(path.dirname(dst));
    await copyFile(src, dst);
    if (onFile) onFile(src, dst, stat.size);
    return stat.size;
  }
  await ensureDir(dst);
  let total = 0;
  const entries = readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dst, e.name);
    if (exclude.some((rx) => rx.test(sp))) continue;
    if (e.isDirectory()) {
      total += await copyTree(sp, dp, opts);
    } else if (e.isFile()) {
      await ensureDir(path.dirname(dp));
      await copyFile(sp, dp);
      const sz = statSync(sp).size;
      total += sz;
      if (onFile) onFile(sp, dp, sz);
    }
  }
  return total;
}

// -------------------------- locate sources --------------------------
const NEXT_DIR = path.join(ROOT, ".next");
if (!existsSync(NEXT_DIR)) {
  die(
    'Missing .next/ — run "npm run build" before migrating.\n  Production payload requires the built bundle.'
  );
}
const NODE_MODULES = path.join(ROOT, "node_modules");
if (!existsSync(NODE_MODULES)) {
  die("Missing node_modules/ — run npm install first.");
}

// Ollama Windows install dir — must copy the WHOLE tree, not just
// ollama.exe. The runtime needs lib/ollama/*.dll (GGML, CUDA, BLAS,
// per-CPU variants). Caught during H8.5 live PNY cold-start: a copy
// of just ollama.exe hangs on --version because the GGML runtime
// libraries can't be located. See methodology/corrections.md.
const OLLAMA_WIN_DIR = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "Programs",
  "Ollama"
);
const OLLAMA_WIN = path.join(OLLAMA_WIN_DIR, "ollama.exe");
const ollamaWinAvailable = existsSync(OLLAMA_WIN);

// Ollama models dir
const OLLAMA_MODELS_SRC = path.join(os.homedir(), ".ollama", "models");
const ollamaModelsAvailable = existsSync(OLLAMA_MODELS_SRC);

// -------------------------- safety check on target -----------------
if (existsSync(ABS_TARGET)) {
  const looksLikePayload =
    existsSync(path.join(ABS_TARGET, "launcher.bat")) ||
    existsSync(path.join(ABS_TARGET, "app", ".next")) ||
    existsSync(path.join(ABS_TARGET, "models", "manifests"));
  if (looksLikePayload && !ACK_OVERWRITE) {
    die(
      `Target ${ABS_TARGET} already contains an ARGOS payload.\n` +
        `  Re-run with --i-acknowledge-overwrite to proceed.`
    );
  }
}

// -------------------------- plan + execute --------------------------
console.log(`migrate-to-usb — ${PKG.name} v${PKG.version}`);
console.log("=".repeat(64));
console.log(`Source:  ${ROOT}`);
console.log(`Target:  ${ABS_TARGET}`);
console.log(`Mode:    ${DRY_RUN ? "DRY-RUN (no writes)" : "EXECUTE"}`);
console.log(`Ollama bin (win):   ${ollamaWinAvailable ? OLLAMA_WIN : "(not found — will skip)"}`);
console.log(`Ollama models src:  ${ollamaModelsAvailable ? OLLAMA_MODELS_SRC : "(not found — will skip)"}`);
console.log(`Skip models:        ${SKIP_MODELS ? "yes" : "no"}`);
console.log("");

const t0 = Date.now();
const sizes = {};

// 1) ARGOS root dir
await ensureDir(ABS_TARGET);

// 2) Launchers at root
console.log("[1/9] Copying launchers...");
sizes.launchers = 0;
for (const name of ["launcher.bat", "launcher.command", "launcher.sh"]) {
  const src = path.join(ROOT, "launchers", name);
  if (existsSync(src)) {
    sizes.launchers += await copyTree(src, path.join(ABS_TARGET, name));
  }
}

// 3) bin/ — copy the FULL Ollama install dir, not just ollama.exe
//    (lib/ollama/*.dll is required at runtime). Result: F:\ARGOS\bin\
//    mirrors %LOCALAPPDATA%\Programs\Ollama\ exactly.
console.log("[2/9] Copying bin/ (full Ollama install tree)...");
await ensureDir(path.join(ABS_TARGET, "bin"));
sizes.bin = 0;
if (ollamaWinAvailable) {
  sizes.bin += await copyTree(OLLAMA_WIN_DIR, path.join(ABS_TARGET, "bin"));
} else {
  console.log("    [skip] no Windows Ollama install found");
}

// 4) app/.next
console.log("[3/9] Copying app/.next/ (production build)...");
const APP_DST = path.join(ABS_TARGET, "app");
await ensureDir(APP_DST);
sizes.next = await copyTree(NEXT_DIR, path.join(APP_DST, ".next"), {
  exclude: [/[\\/]\.next[\\/]cache[\\/]/, /[\\/]trace$/],
});

// 5) app/node_modules — only runtime deps, with deny-list filter
console.log("[4/9] Copying app/node_modules/ (runtime deps only)...");
const runtimeDeps = Object.keys(PKG.dependencies ?? {});
sizes.node_modules = 0;
await ensureDir(path.join(APP_DST, "node_modules"));
for (const dep of runtimeDeps) {
  const src = path.join(NODE_MODULES, ...dep.split("/"));
  const dst = path.join(APP_DST, "node_modules", ...dep.split("/"));
  if (!existsSync(src)) {
    console.log(`    [warn] missing dep ${dep}`);
    continue;
  }
  sizes.node_modules += await copyTree(src, dst);
}
// Transitive deps: copy any sub-package that the runtime deps import.
// Cheap heuristic: copy the whole node_modules but skip the dev-only
// roots (the deps NOT in PKG.dependencies and not in the runtime
// transitive graph). For v1 we just copy every package directory at
// node_modules root that isn't in devDependencies. Saves the trouble
// of walking lockfile.
const devDeps = new Set(Object.keys(PKG.devDependencies ?? {}));
const allTopLevel = readdirSync(NODE_MODULES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("."))
  .map((e) => e.name);
const NONDEV_SCOPES_TO_CRAWL = ["@radix-ui", "@swc"];
const failedCopies = [];
for (const entry of allTopLevel) {
  if (devDeps.has(entry)) continue;
  if (runtimeDeps.includes(entry)) continue; // already copied
  // Copy scoped dirs entirely if they aren't dev-only roots
  const dst = path.join(APP_DST, "node_modules", entry);
  if (existsSync(dst)) continue;
  const src = path.join(NODE_MODULES, entry);
  try {
    sizes.node_modules += await copyTree(src, dst);
  } catch (e) {
    failedCopies.push({ entry, err: e instanceof Error ? e.message : String(e) });
  }
}
if (failedCopies.length > 0) {
  console.log(`    [warn] ${failedCopies.length} transitive entries failed to copy (logged, continuing):`);
  for (const f of failedCopies.slice(0, 10)) {
    console.log(`      - ${f.entry}: ${f.err.slice(0, 80)}`);
  }
  if (failedCopies.length > 10) console.log(`      ... ${failedCopies.length - 10} more`);
}

// 6) app/package.json + lockfile
console.log("[5/9] Copying app/package.json + lock + next.config.mjs...");
sizes.appmeta = 0;
for (const f of [
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  "tsconfig.json",
  "tailwind.config.ts",
  "postcss.config.js",
]) {
  const src = path.join(ROOT, f);
  if (existsSync(src)) {
    sizes.appmeta += await copyTree(src, path.join(APP_DST, f));
  }
}

// 7) models/
console.log("[6/9] Copying models/ ...");
sizes.models = 0;
if (SKIP_MODELS) {
  console.log("    [skip] --skip-models specified");
} else if (ollamaModelsAvailable) {
  sizes.models = await copyTree(
    OLLAMA_MODELS_SRC,
    path.join(ABS_TARGET, "models")
  );
} else {
  console.log("    [skip] no Ollama models dir found");
}

// 8) Empty runtime dirs
console.log("[7/9] Creating runtime dirs (vault, logs, tmp, config)...");
for (const d of [
  ["vault", "docs"],
  ["vault", "index", "chunks"],
  ["logs"],
  ["tmp"],
  ["config"],
]) {
  await ensureDir(path.join(ABS_TARGET, ...d));
}
// Default settings.json
const defaultSettings = {
  version: 1,
  defaultPersona: "bartimaeus",
  defaultModel: "llama3.1:8b-instruct-q4_K_M",
  updatedAt: 0,
};
if (!DRY_RUN) {
  await fsp.writeFile(
    path.join(ABS_TARGET, "config", "settings.json"),
    JSON.stringify(defaultSettings, null, 2),
    "utf8"
  );
}

// 9) docs/, methodology/, README.txt
console.log("[8/9] Copying docs/ + methodology/ (read-only doctrine + audit trail)...");
sizes.docs = 0;
sizes.methodology = 0;
if (existsSync(path.join(ROOT, "docs"))) {
  sizes.docs = await copyTree(
    path.join(ROOT, "docs"),
    path.join(ABS_TARGET, "docs")
  );
}
if (existsSync(path.join(ROOT, "methodology"))) {
  sizes.methodology = await copyTree(
    path.join(ROOT, "methodology"),
    path.join(ABS_TARGET, "methodology"),
    { exclude: [/[\\/]sessions[\\/]/] }
  );
}

// README.txt
const readme = [
  "ARGOS - local-first AI workstation",
  "===================================",
  "",
  "Quick start:",
  "  Windows: double-click launcher.bat",
  "  macOS:   right-click launcher.command -> Open (first launch)",
  "  Linux:   ./launcher.sh from terminal",
  "",
  "What happens:",
  "  1. Ollama starts on 127.0.0.1:11434",
  "  2. Next.js starts on 127.0.0.1:7799",
  "  3. Your default browser opens to http://127.0.0.1:7799",
  "  4. Close the launcher window for clean shutdown",
  "",
  "Storage:",
  "  vault/   your indexed documents (drop files via the Vault tab)",
  "  config/  per-machine settings (defaultPersona, defaultModel)",
  "  logs/    launcher + service logs from this session",
  "  models/  Ollama model store (set via OLLAMA_MODELS env)",
  "",
  "No host writes outside this directory. See docs/01-SEVEN-RULES.md.",
  "",
  `Build: ${PKG.name} v${PKG.version}`,
  `Migrated: ${new Date().toISOString()}`,
].join("\n");
if (!DRY_RUN) {
  await fsp.writeFile(
    path.join(ABS_TARGET, "README.txt"),
    readme,
    "utf8"
  );
}
sizes.readme = readme.length;

// -------------------------- post-migration smoke --------------------
// v2 hardening: confirm the copied ollama binary can at least answer
// --version. Doesn't validate `serve` (which depends on lib/ being
// findable at runtime via the installer's path-resolution conventions
// — see corrections.md 2026-05-20 entry), but catches the gross
// "binary didn't copy / lib/ missing" class of failure.
let smokeResult = null;
if (!DRY_RUN && !SKIP_SMOKE) {
  console.log("\n[post-smoke] running <target>/bin/ollama.exe --version ...");
  smokeResult = smokePostMigration(ABS_TARGET);
  if (smokeResult.skipped) {
    console.log(`    [skip] ${smokeResult.skipped}`);
  } else if (smokeResult.ok) {
    console.log(`    [ok]   ${smokeResult.output}`);
  } else {
    console.log(`    [WARN] post-migration smoke failed: ${smokeResult.error}`);
    console.log(`    [WARN] continuing — but verify the bin/ copy before relying on it.`);
  }
}

// -------------------------- summary --------------------------
console.log("\n[9/9] Verifying payload...");
let payloadBytes = 0;
if (!DRY_RUN) {
  payloadBytes = await dirSize(ABS_TARGET);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nMigration ${DRY_RUN ? "DRY-RUN" : "complete"} in ${elapsed}s`);
console.log("=".repeat(64));
const order = ["launchers", "bin", "next", "node_modules", "appmeta", "models", "docs", "methodology"];
for (const k of order) {
  const v = sizes[k] ?? 0;
  console.log(`  ${k.padEnd(14)} ${fmtMB(v).padStart(12)}`);
}
console.log("  " + "-".repeat(28));
const planned = order.reduce((s, k) => s + (sizes[k] ?? 0), 0);
console.log(`  ${"PLANNED".padEnd(14)} ${fmtMB(planned).padStart(12)}  (${fmtGB(planned)})`);
if (!DRY_RUN) {
  console.log(`  ${"ON-DISK".padEnd(14)} ${fmtMB(payloadBytes).padStart(12)}  (${fmtGB(payloadBytes)})`);
}
console.log(`\nTarget: ${ABS_TARGET}`);
if (smokeResult && !smokeResult.ok && !smokeResult.skipped) {
  console.log(`Post-migration smoke: WARN (${smokeResult.error.slice(0, 100)})`);
} else if (smokeResult && smokeResult.ok) {
  console.log(`Post-migration smoke: OK`);
}

// -------------------------- v2 deferral note ------------------------
// Transactional staged-write pattern (stage to .tmp, fsync, atomic
// rename) was filed as a v2 hardening in corrections.md after the
// H8.5 NTFS-corruption-from-yank incident. It's NOT implemented here
// because the natural implementation point is per-large-file (models),
// which means staging ~12 GB of model blobs in .tmp before rename —
// expensive and arguably worse than the current direct-write since
// the user might yank mid-stage just as easily as mid-write.
//
// The proper fix is at the OS level (use BypassWriteCache + FlushFile
// or robocopy /B with its own buffer discipline). Filed for v3 review.
// For now: the launcher.bat eject path uses `mountvol /p` which gives
// Windows a chance to flush + dismount cleanly; that's the user-side
// mitigation.
