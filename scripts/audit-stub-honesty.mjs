#!/usr/bin/env node
// audit-stub-honesty.mjs
//
// Stub pages exist so that doctrine in docs/02-SCOPE-LOCK.md is visible
// inside the product. This audit asserts each stub page contains the
// honesty markers we expect and contains no fake interactivity.
//
// Pass: every stub page mentions v2, Path B, and docs/02-SCOPE-LOCK.md;
//       has a "Why not v1" section; does not import useState; makes no
//       fetch calls; has no real onClick handlers that wire up logic.
//
// Exit 0 = clean. Exit 1 = at least one stub failed.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Pages that are STILL stubs (deferred, never built). The audit asserts
// they carry the honesty markers and no fake interactivity.
//
// 2026-05-31: Memory (app/memory/page.tsx) and Tools (app/tools/page.tsx)
// were REMOVED from this list — they are now real, built-out features
// (Memory: Phase 9 persistent memory UI; Tools: Phase 10/11 research +
// scheduler/alerts UI), so they legitimately use useState/useEffect/
// fetch and must NOT be held to stub-honesty rules.
//
// 2026-06-01: Voice (app/voice/page.tsx) REMOVED for the same reason —
// Phase 7-D shipped live voice I/O.
//
// 2026-06-02: Vision (app/vision/page.tsx) REMOVED — Vision Phase 1 shipped
// image drop, file vision, and screenshot awareness (gemma4-turbo routing).
// The Vision page now renders real live status via the VisionStatusPanel
// client component (useState/useEffect + fetch /api/vision/status), so it is
// no longer a deferred placeholder. No stub pages remain; this audit now only
// enforces the workspace-switcher honesty (below). The array is kept (empty)
// so the harness stays in place for any future deferred page.
const STUBS = [];

const REQUIRED_PHRASES = [
  { id: "v2-label", needle: /\bv2\b/i },
  { id: "path-b-reference", needle: /Path\s*B/i },
  { id: "scope-lock-reference", needle: /docs\/02-SCOPE-LOCK\.md/i },
  { id: "why-not-v1-section", needle: /Why\s+not\s+v1/i },
  { id: "what-this-will-do-section", needle: /What\s+this\s+will\s+do/i },
];

const FORBIDDEN_PATTERNS = [
  { id: "useState-import", needle: /\buseState\b/, note: "stubs must not own local state" },
  { id: "useEffect-import", needle: /\buseEffect\b/, note: "stubs must not run effects" },
  { id: "real-fetch-call", needle: /\bfetch\s*\(/, note: "stubs must not call APIs" },
  { id: "real-onClick", needle: /onClick=\{[^}]*=>\s*(?!e\.preventDefault\(\)\s*)[^}]+\}/, note: "stubs must not have wired onClick handlers (preventDefault-only is allowed)" },
];

let totalFails = 0;

for (const stub of STUBS) {
  const full = resolve(ROOT, stub.path);
  console.log(`\n=== ${stub.name} (${stub.path}) ===`);
  if (!existsSync(full)) {
    console.log(`  [FAIL] file does not exist`);
    totalFails++;
    continue;
  }
  const src = readFileSync(full, "utf8");

  for (const req of REQUIRED_PHRASES) {
    const ok = req.needle.test(src);
    console.log(`  ${ok ? "[ ok ]" : "[FAIL]"} required: ${req.id}`);
    if (!ok) totalFails++;
  }

  const weekOk = stub.weekPattern.test(src);
  console.log(
    `  ${weekOk ? "[ ok ]" : "[FAIL]"} required: week-marker matches ${stub.weekPattern}`
  );
  if (!weekOk) totalFails++;

  for (const forb of FORBIDDEN_PATTERNS) {
    const found = forb.needle.test(src);
    console.log(
      `  ${found ? "[FAIL]" : "[ ok ]"} forbidden: ${forb.id}${found ? ` — ${forb.note}` : ""}`
    );
    if (found) totalFails++;
  }
}

// Workspace switcher honesty
console.log(`\n=== Workspace switcher (components/LeftRail.tsx) ===`);
const railPath = resolve(ROOT, "components/LeftRail.tsx");
const rail = readFileSync(railPath, "utf8");
const railChecks = [
  { id: "operator-active", needle: /id:\s*"operator".*active:\s*true/s },
  {
    id: "workspace-v2-note",
    needle: /Workspaces\s+ship\s+in\s+v2/i,
  },
  { id: "scope-lock-link", needle: /docs\/02-SCOPE-LOCK\.md/i },
  { id: "data-workspace-attr", needle: /data-workspace=/ },
];
for (const c of railChecks) {
  const ok = c.needle.test(rail);
  console.log(`  ${ok ? "[ ok ]" : "[FAIL]"} ${c.id}`);
  if (!ok) totalFails++;
}

console.log(
  "\n" +
    (totalFails === 0
      ? "Stub honesty audit: PASS (all checks green)"
      : `Stub honesty audit: ${totalFails} FAIL${totalFails === 1 ? "" : "S"}`)
);
process.exit(totalFails === 0 ? 0 : 1);
