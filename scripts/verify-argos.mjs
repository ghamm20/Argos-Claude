#!/usr/bin/env node
// verify-argos.mjs — Executable Seven USB-Native Rules harness.
//
// This script is the executable form of the Seven Rules (docs/01-SEVEN-RULES.md).
// It must catch real violations. If it ever drifts into a feel-good `print "OK"`
// pass, it has failed its purpose. Self-test by injecting violations before trust.
//
// Exit 0 = clean. Exit 1 = at least one rule failed.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const SELF_REL = relative(ROOT, __filename).split(/[\\/]/).join("/");

const SCAN_DIRS = ["app", "components", "lib", "scripts"];
const SCAN_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "out", "dist"]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(full);
    } else {
      const ext = entry.includes(".") ? "." + entry.split(".").pop() : "";
      if (SCAN_EXTS.has(ext)) yield full;
    }
  }
}

function listSources() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    for (const f of walk(join(ROOT, dir))) files.push(f);
  }
  return files;
}

function relPosix(p) {
  return relative(ROOT, p).split(/[\\/]/).join("/");
}

function isSelf(file) {
  return relPosix(file) === SELF_REL;
}

const checks = [];
function record(name, ok, details = []) {
  checks.push({ name, ok, details });
}

// ---------- RULE 1: hardcoded absolute paths in source ----------
{
  // Catches Windows drive letters and common Unix user/system roots inside string literals.
  const re =
    /(["'`])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/mnt\/[a-zA-Z]|\/private\/var\/|\/var\/folders\/|\/tmp\/[a-zA-Z])/;
  const violations = [];
  for (const f of listSources()) {
    if (isSelf(f)) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (re.test(line)) {
        violations.push(`${relPosix(f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  record(
    "Rule 1: no hardcoded absolute paths (C:\\, D:\\, /Users/, /home/, /mnt/, /tmp/, /var/)",
    violations.length === 0,
    violations
  );
}

// ---------- RULE 2: no network/analytics packages in runtime deps ----------
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const deps = { ...(pkg.dependencies || {}) };
  // Matches by exact name or namespace prefix. Devbundle equivalents allowed in devDependencies.
  const FLAGGED = [
    /^axios$/,
    /^node-fetch$/,
    /^got$/,
    /^request$/,
    /^superagent$/,
    /^isomorphic-fetch$/,
    /^cross-fetch$/,
    /^@sentry\//,
    /^sentry$/,
    /^raven$/,
    /^posthog/,
    /^@posthog\//,
    /^@segment\//,
    /^analytics-node$/,
    /^segment-analytics/,
    /^mixpanel/,
    /^@mixpanel\//,
    /^@amplitude\//,
    /^amplitude-js$/,
    /^@vercel\/analytics$/,
    /^@vercel\/speed-insights$/,
    /^datadog/,
    /^dd-trace$/,
    /^@datadog\//,
    /^newrelic/,
    /^@newrelic\//,
    /^fullstory/,
    /^@fullstory\//,
    /^hotjar/,
    /^google-analytics/,
    /^@google-analytics\//,
    /^heap-analytics$/,
    /^launchdarkly/,
    /^@launchdarkly\//,
  ];
  const violations = [];
  for (const [name, version] of Object.entries(deps)) {
    if (FLAGGED.some((re) => re.test(name))) {
      violations.push(
        `package.json dependencies.${name}@${version}: flagged as network/analytics — move to devDependencies or remove`
      );
    }
  }
  record(
    "Rule 2: no network / analytics packages in runtime dependencies",
    violations.length === 0,
    violations
  );
}

// ---------- RULE 3: filesystem path concatenation must use path.join ----------
{
  // Heuristic: a line that calls fs.* or path.resolve|normalize|format AND
  // contains either string-with-slash concat or template-literal slash-interpolation
  // is flagged. False positives possible — keep the regex tight.
  const fsCall =
    /\b(?:fs|fsp|fsPromises)\.[a-zA-Z]+\s*\(|\bpath\.(?:resolve|normalize|format)\s*\(/;
  const concatLiteralSlash = /["'][^"'\n]*[\\/][^"'\n]*["']\s*\+/;
  const tplWithSlashInterp =
    /`[^`]*\$\{[^}]+\}[^`]*[\\/][^`]*`|`[^`]*[\\/]\s*\$\{[^}]+\}[^`]*`/;
  const violations = [];
  for (const f of listSources()) {
    if (isSelf(f)) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!fsCall.test(line)) return;
      if (concatLiteralSlash.test(line) || tplWithSlashInterp.test(line)) {
        violations.push(
          `${relPosix(f)}:${i + 1}: ${line.trim()} — use path.join() instead of manual slash`
        );
      }
    });
  }
  record(
    "Rule 3: filesystem path operations use path.join (no manual slash concat)",
    violations.length === 0,
    violations
  );
}

// ---------- RULE 4: no external CDN imports / remote fetch in source ----------
{
  // Remote imports, remote asset references, and remote fetch calls.
  // Allows localhost and 127.0.0.1 (local Ollama, etc).
  const remoteImport = /(?:from|import)\s+["']https?:\/\/[^"']+["']/;
  const remoteAsset =
    /(?:src|href)\s*=\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)[^"']+["']/;
  const remoteFetch =
    /\bfetch\s*\(\s*["'`]https?:\/\/(?!localhost|127\.0\.0\.1)[^"'`]+["'`]/;
  const violations = [];
  for (const f of listSources()) {
    if (isSelf(f)) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (
        remoteImport.test(line) ||
        remoteAsset.test(line) ||
        remoteFetch.test(line)
      ) {
        violations.push(`${relPosix(f)}:${i + 1}: ${trimmed}`);
      }
    });
  }
  record(
    "Rule 4: no external CDN imports / remote fetch in source (localhost OK)",
    violations.length === 0,
    violations
  );
}

// ---------- RULE 5: storage paths derive from ARGOS_ROOT ----------
{
  // Flags fs writes whose first argument is a hardcoded absolute path literal.
  // Writes derived from a path variable (e.g. path.join(process.env.ARGOS_ROOT, ...)) pass.
  const writeRe =
    /\b(?:fs|fsp|fsPromises)\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync|rm|rmSync|unlink|unlinkSync)\s*\(\s*([^,)]+)/g;
  const absLiteral =
    /^["'`](?:[A-Za-z]:[\\/]|\/(?:Users|home|mnt|tmp|var|private)\/)/;
  const violations = [];
  for (const f of listSources()) {
    if (isSelf(f)) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      writeRe.lastIndex = 0;
      let m;
      while ((m = writeRe.exec(line)) !== null) {
        const arg = m[1].trim();
        if (absLiteral.test(arg)) {
          violations.push(
            `${relPosix(f)}:${i + 1}: fs write target ${arg} is a hardcoded absolute path — must derive from process.env.ARGOS_ROOT`
          );
        }
      }
    });
  }
  record(
    "Rule 5: storage paths derive from ARGOS_ROOT (no hardcoded absolute roots in fs writes)",
    violations.length === 0,
    violations
  );
}

// ---------- Report ----------
let failed = 0;
const sep = "─".repeat(64);
process.stdout.write(`\nverify-argos — Seven USB-Native Rules harness\n${sep}\n`);
for (const c of checks) {
  const tag = c.ok ? "PASS" : "FAIL";
  process.stdout.write(`[${tag}] ${c.name}\n`);
  if (!c.ok) {
    failed++;
    for (const d of c.details) process.stdout.write(`       · ${d}\n`);
  }
}
process.stdout.write(`${sep}\n`);
if (failed === 0) {
  process.stdout.write(`All ${checks.length} rule groups passed.\n`);
} else {
  process.stdout.write(`${failed}/${checks.length} rule group(s) FAILED.\n`);
}
process.exit(failed === 0 ? 0 : 1);
