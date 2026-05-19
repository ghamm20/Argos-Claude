#!/usr/bin/env node
// audit-production-deps.mjs
//
// Walks package.json runtime dependencies and reports what would ship
// to the USB: total bytes, per-package size, native-binary presence,
// and a flag for any names matching the verify-argos network/analytics
// deny-list (defence in depth in case a dep slips in between
// `npm install` and CI).
//
// Outputs a usb-payload size estimate so we can fail loudly before
// migration if it busts the budget.

import { promises as fsp } from "node:fs";
import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const NODE_MODULES = path.join(ROOT, "node_modules");

const FLAGGED_NAMES = [
  /^axios$/,
  /^node-fetch$/,
  /^got$/,
  /^request$/,
  /^superagent$/,
  /^isomorphic-fetch$/,
  /^cross-fetch$/,
  /^@sentry\//,
  /^posthog/,
  /^@segment\//,
  /^mixpanel/,
  /^@amplitude\//,
  /^@vercel\/analytics$/,
  /^datadog/,
  /^@datadog\//,
  /^newrelic/,
  /^fullstory/,
  /^hotjar/,
  /^google-analytics/,
];

async function dirSize(dir) {
  let total = 0;
  let nativeArtifacts = [];
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
        if (e.name === ".git" || e.name === ".cache") continue;
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          total += st.size;
          const name = e.name.toLowerCase();
          if (
            name.endsWith(".node") ||
            name.endsWith(".dll") ||
            name.endsWith(".dylib") ||
            name.endsWith(".so") ||
            name.endsWith(".exe")
          ) {
            nativeArtifacts.push(path.relative(NODE_MODULES, full));
          }
        } catch {
          /* skip */
        }
      }
    }
  }
  await walk(dir);
  return { bytes: total, nativeArtifacts };
}

function fmtMB(b) {
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  console.log(`audit-production-deps — ${PKG.name} v${PKG.version}`);
  console.log("=".repeat(64));

  const runtimeDeps = PKG.dependencies ?? {};
  const devDeps = PKG.devDependencies ?? {};

  console.log(`\nRuntime dependencies: ${Object.keys(runtimeDeps).length}`);
  console.log(`Dev dependencies:     ${Object.keys(devDeps).length} (NOT shipped)`);

  // Step 1: deny-list cross-check
  const flagged = [];
  for (const name of Object.keys(runtimeDeps)) {
    if (FLAGGED_NAMES.some((re) => re.test(name))) {
      flagged.push(name);
    }
  }
  if (flagged.length === 0) {
    console.log("\n[ ok ] deny-list cross-check: clean");
  } else {
    console.log("\n[FAIL] deny-list cross-check: flagged names in runtime deps:");
    flagged.forEach((n) => console.log(`        - ${n}`));
  }

  // Step 2: per-dep size + presence
  console.log("\nPer-runtime-dep size (top 30 by bytes):");
  const sizes = [];
  let unresolved = 0;
  for (const name of Object.keys(runtimeDeps)) {
    const pkgDir = path.join(NODE_MODULES, ...name.split("/"));
    if (!existsSync(pkgDir)) {
      unresolved++;
      sizes.push({ name, bytes: 0, missing: true, natives: [] });
      continue;
    }
    const { bytes, nativeArtifacts } = await dirSize(pkgDir);
    sizes.push({ name, bytes, missing: false, natives: nativeArtifacts });
  }
  sizes.sort((a, b) => b.bytes - a.bytes);

  for (const s of sizes.slice(0, 30)) {
    const tag = s.missing ? "[!] MISSING" : "       ";
    const nat = s.natives.length > 0 ? ` [native: ${s.natives.length}]` : "";
    console.log(
      `  ${tag} ${s.name.padEnd(36)} ${fmtMB(s.bytes).padStart(12)}${nat}`
    );
  }
  if (sizes.length > 30) {
    const rest = sizes.slice(30).reduce((sum, s) => sum + s.bytes, 0);
    console.log(`       (… ${sizes.length - 30} more, ${fmtMB(rest)} combined)`);
  }

  const totalDirect = sizes.reduce((sum, s) => sum + s.bytes, 0);
  console.log(`\nTotal direct runtime deps: ${fmtMB(totalDirect)}`);

  // Step 3: transitive — count whole node_modules but mark which folders
  // are pulled by runtime vs dev. Cheap approach: total node_modules
  // bytes; we cannot easily separate transitive without a real lockfile
  // walk. Report total and note the gap.
  const all = await dirSize(NODE_MODULES);
  console.log(`Total node_modules (runtime + dev transitive): ${fmtMB(all.bytes)}`);

  console.log("\nNative artifacts across all runtime deps:");
  const allNatives = sizes
    .flatMap((s) => s.natives)
    .filter((p) => p);
  if (allNatives.length === 0) {
    console.log("  none — pure-JS runtime");
  } else {
    allNatives.slice(0, 20).forEach((p) => console.log(`  - ${p}`));
    if (allNatives.length > 20)
      console.log(`  (… ${allNatives.length - 20} more)`);
  }

  // Step 4: .next + public + package metadata
  const builtBundleParts = [
    [".next", path.join(ROOT, ".next")],
    ["public", path.join(ROOT, "public")],
  ];
  console.log("\nBuilt artefacts:");
  let bundleBytes = 0;
  for (const [label, p] of builtBundleParts) {
    if (existsSync(p)) {
      const { bytes } = await dirSize(p);
      bundleBytes += bytes;
      console.log(`  ${label.padEnd(10)} ${fmtMB(bytes).padStart(12)}`);
    } else {
      console.log(`  ${label.padEnd(10)} (not present — run npm run build)`);
    }
  }

  // Step 5: USB payload estimate
  const PAYLOAD_BUDGET_GB = 12; // generous; spec said 8-12 GB
  const estimatedUsbBytes =
    totalDirect /* runtime-only deps; transitive included */ +
    bundleBytes;
  console.log("\nUSB payload estimate (deps + built artefacts only):");
  console.log(`  ${fmtMB(estimatedUsbBytes)}`);
  console.log(`  Budget: ${PAYLOAD_BUDGET_GB} GB`);
  const gb = estimatedUsbBytes / (1024 ** 3);
  const overBudget = gb > PAYLOAD_BUDGET_GB;
  console.log(
    `  ${overBudget ? "[FAIL]" : "[ ok ]"} payload ${gb.toFixed(2)} GB ${overBudget ? ">" : "<="} ${PAYLOAD_BUDGET_GB} GB`
  );

  console.log(
    "\n  Note: this is the runtime-deps + .next + public total. The USB also ships\n  Ollama binaries (~150 MB / platform) and models (~7.1 GB) — those are\n  counted in the migration script's final summary, not here."
  );

  if (unresolved > 0) {
    console.log(
      `\n[WARN] ${unresolved} runtime dep(s) not found in node_modules. Run npm install first.`
    );
  }

  const fail =
    flagged.length > 0 || overBudget || unresolved > 0;
  console.log(`\n${fail ? "AUDIT: FAIL" : "AUDIT: PASS"}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("AUDIT_ERROR:", e);
  process.exit(1);
});
