#!/usr/bin/env node
// preview-workspace-server.mjs — Phase 6 render-gate fixture server.
// Builds a deterministic ARGOS_ROOT fixture (PIN 1234, one pending proposal,
// one halted workflow, task fixtures) and runs `next start -p 7799` against
// it. Used by .claude/launch.json for the preview render proofs. R1: never
// touches Ollama (panels degrade gracefully without it).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(tmpdir(), "argos-preview-workspace-root");
rmSync(ROOT, { recursive: true, force: true });

const hashPin = (pin) => createHash("sha256").update(`ARGOS_OPERATOR_${pin.length}`).update(pin).digest("hex");

// settings: PIN 1234 + requirePin (deployed posture).
mkdirSync(join(ROOT, "config"), { recursive: true });
writeFileSync(join(ROOT, "config", "settings.json"), JSON.stringify({ operatorPinHash: hashPin("1234"), requirePin: true }, null, 2), "utf8");

// one pending proposal (pre-fetch shaped) + one decided.
mkdirSync(join(ROOT, "state", "proposals", "pending"), { recursive: true });
mkdirSync(join(ROOT, "state", "proposals", "decided"), { recursive: true });
writeFileSync(join(ROOT, "state", "proposals", "pending", "p_fixture1.json"), JSON.stringify({
  id: "p_fixture1", at: new Date().toISOString(), type: "research_brief",
  title: "Pre-fetch research for a predicted question",
  rationale: "Predicted next ask class=research_web/question at p=0.83 — recurring research thread [claim:c_fixture]",
  reasoning: ["probabilistic", "abductive", "neuro-symbolic"], confidence: 0.83,
  predictionClaimId: "c_fixture", predictedAsk: { topicClass: "research_web", queryType: "question" },
  action: { toolId: "web_search", params: { query: "fixture", limit: 3 } },
  status: "pending", decidedAt: null, result: null,
}, null, 2), "utf8");

// one halted workflow (delete mid-chain) for the Parascope panel.
mkdirSync(join(ROOT, "state", "workflows"), { recursive: true });
writeFileSync(join(ROOT, "state", "workflows", "wf_fixture1.json"), JSON.stringify({
  id: "wf_fixture1", title: "archive sweep with embedded delete", at: new Date().toISOString(),
  steps: [
    { toolId: "file_ops", params: { operation: "write", path: "workspace/a.txt", content: "x" }, description: "write" },
    { toolId: "file_ops", params: { operation: "delete", path: "workspace/a.txt" }, description: "delete" },
    { toolId: "file_ops", params: { operation: "write", path: "workspace/b.txt", content: "y" }, description: "tail" },
  ],
  results: [{ ok: true, toolId: "file_ops", summary: "wrote workspace/a.txt" }, null, null],
  cursor: 1, status: "halted_approval",
  halted: { toolId: "file_ops", resolvedParams: { operation: "delete", path: "workspace/a.txt" }, reason: "step 2/3 (file_ops) requires operator approval — chain halted, nothing after it has run" },
  updatedAt: new Date().toISOString(), error: null,
}, null, 2), "utf8");

// task + brief fixtures for the Jenna panel.
mkdirSync(join(ROOT, "tasks", "queue"), { recursive: true });
mkdirSync(join(ROOT, "tasks", "complete"), { recursive: true });
mkdirSync(join(ROOT, "output"), { recursive: true });
const date = new Date().toISOString().slice(0, 10);
writeFileSync(join(ROOT, "output", `morning-brief-${date}.md`), [
  `# Morning Brief — ${date}`, "",
  "## VERDICT BLOCK", "",
  "- GREEN  t1-fixture \"sample\" — 1/1 steps ok  [result:tasks/complete/t1-fixture-result.json]",
  "- GREEN  audit chain: 12 entries, verify PASS  [audit:state/audit/chain.jsonl]",
  "- GREEN  observation corpus: 5 entries, verify PASS  [obs:state/observation.jsonl]", "",
  "Quiet night.", "",
].join("\n"), "utf8");
mkdirSync(join(ROOT, "workspace"), { recursive: true });

const server = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-p", "7799"],
  { cwd: repoRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ARGOS_ROOT: ROOT }, stdio: "inherit", windowsHide: true });
server.on("exit", (c) => process.exit(c ?? 0));
