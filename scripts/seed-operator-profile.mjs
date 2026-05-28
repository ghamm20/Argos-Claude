#!/usr/bin/env node
// seed-operator-profile.mjs — Phase 9 (2026-05-27) operator profile seed.
//
// Idempotent: writes the canonical operator profile to
// $ARGOS_ROOT/data/memory/shared/operator_profile.json (or via the
// running ARGOS instance's POST /api/memory/profile if one is up).
//
// Default mode: direct file write via lib/memory/store.ts. That works
// without a server running, which is what the build/install workflow
// wants (seed → first launch already has memory).
//
// Usage:
//   node scripts/seed-operator-profile.mjs                  # direct write
//   node scripts/seed-operator-profile.mjs --via-api 7799   # POST to running server
//
// The seed payload is locked here so re-running it doesn't drift.

import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..");

const args = process.argv.slice(2);
const viaApiIdx = args.indexOf("--via-api");
const viaApi = viaApiIdx >= 0 ? parseInt(args[viaApiIdx + 1], 10) : null;

const PROFILE = {
  name: "Gordy",
  role: "Security Executive / Operator — EKG Security, COO. Builder of AI systems under unified trust infrastructure.",
  context:
    "Building ARGOS — USB-native local AI workstation with 4 personas. Primary projects: ARGOS, Jenna, Parascope, Sentry, Cortex, Halal Jordan. RTX 3060 Ti / 8GB VRAM. 5090 inbound. Execution-first mindset. Prefers direct, unhedged responses. No fluff.",
  preferences: {
    response_style:
      "Direct. Short sentences. No preamble. No motivational talk.",
    technical_depth: "Expert. Do not explain basics.",
    honesty: "Brutal honesty over agreement. Call out weak logic.",
    format: "Bullets and steps for technical. Prose for conversation.",
  },
};

async function seedDirect() {
  // Import the compiled / TS module via the dev source. Next.js with
  // SWC handles the TS at runtime when invoked through tsx/ts-node, but
  // scripts/ here use ESM JS. We register the @ alias resolver
  // manually by reading the file path. Simpler approach: use
  // dynamic import on the .ts file via the TypeScript stripping path
  // provided by Next when running under its bundler — NOT available
  // standalone. So we duplicate the write logic here using the same
  // filesystem layout the lib uses.
  //
  // Tradeoff: small duplication, but avoids a tsx/ts-node dependency.
  // The lib stays authoritative for the format; this script just
  // emits a file the lib will happily parse on next read.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const root =
    process.env.ARGOS_DATA_DIR && process.env.ARGOS_DATA_DIR.length > 0
      ? path.join(process.env.ARGOS_DATA_DIR, "memory")
      : path.join(
          process.env.ARGOS_ROOT && process.env.ARGOS_ROOT.length > 0
            ? process.env.ARGOS_ROOT
            : repoRoot,
          "data",
          "memory"
        );
  const sharedDir = path.join(root, "shared");
  await fs.mkdir(sharedDir, { recursive: true });
  const out = path.join(sharedDir, "operator_profile.json");
  const next = { ...PROFILE, last_updated: new Date().toISOString() };
  await fs.writeFile(out, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`seeded operator profile → ${out}`);
}

async function seedViaApi(port) {
  const url = `http://127.0.0.1:${port}/api/memory/profile`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(PROFILE),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`POST ${url} → HTTP ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`seeded operator profile via API on port ${port}`);
  console.log(text);
}

try {
  if (viaApi !== null && Number.isFinite(viaApi)) {
    await seedViaApi(viaApi);
  } else {
    await seedDirect();
  }
} catch (e) {
  console.error(`seed failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
}
