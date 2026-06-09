// scripts/tool-call-harness.mjs
//
// Standalone tool-call emission harness — ROUND 2 (2026-06-09).
// Round 1 measured 4 installed models against the verbatim production tool
// block (PROMPT A). Round 2 adds the two pulled candidates (hermes3:8b,
// qwen3:8b) and A/B-tests the prompt-fix hypothesis from round 1's evidence:
// the dominant malform was `"action"` instead of `"operation"` (params schema
// never specified) plus disclosure-stall on gated ops (approval flow never
// explained). PROMPT B = verbatim block + explicit file_ops params schema +
// one approval-flow line. HARNESS-LOCAL ONLY — production prompt files are
// untouched.
//
// Parse-and-score ONLY — no tool is ever executed; the harness writes only its
// own evidence JSONL.
//
// VERBATIM GUARANTEE (PROMPT A): the system prompt is NOT a paraphrase. The
// harness re-derives buildToolAwarenessBlock(<bobby subset>) by extracting the
// literal TOOL_MECHANICS / SCOPED_SOURCE_GUIDANCE blocks from
// lib/tools/chat-tools.ts, the bobby tool subset from
// lib/persona-tool-subsets.ts, and each tool's id/description/requiresApproval
// from lib/tools/registry.ts — assembled with the exact production logic
// (buildToolAwarenessBlock + toolListForPrompt). Extraction failure ABORTS.
//
// CARRYOVER: round-1 records in scripts/harness-evidence.jsonl (untagged) are
// treated as PROMPT A results and are NOT re-run; new records append with a
// `variant` tag. The final table aggregates all rounds.
//
// Sampling: production app/api/chat/route.ts sets NO temperature → directive
// pins 0.7. think:false mirrors the production default.
//
// Usage:  node scripts/tool-call-harness.mjs
// Env:    OLLAMA_BASE (default http://127.0.0.1:11434)

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434";
const EVIDENCE_PATH = path.join(REPO_ROOT, "scripts", "harness-evidence.jsonl");

const TRIALS = parseInt(process.env.ARGOS_HARNESS_TRIALS ?? "3", 10);
const TEMPERATURE = 0.7; // directive: production sets none → 0.7
const REQUEST_TIMEOUT_MS = 240_000; // cold load + spill-to-RAM headroom (8 GB VRAM)

const CANDIDATES = [
  { model: "hermes3:8b", label: "candidate (pulled round 2; tool-trained)" },
  { model: "qwen3:8b", label: "candidate (pulled round 2)" },
  { model: "aratan/gemma-4-E4B-q8-it-heretic:latest", label: "baseline (Bart/Sage binding)" },
  { model: "royhodge812/Orchestrator:lates", label: "candidate (real tag :lates)" },
  { model: "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b", label: "extra: handoff-ranked (Juniper)" },
  { model: "CyberCrew/notmythos-8b:latest", label: "extra: NEGATIVE CONTROL (known malformer)" },
];
const SKIPPED = ["qwen3-64k (deferred: same family as qwen3:8b — earns a pull only if qwen3:8b wins)"];

// ---------------------------------------------------------------------------
// PROMPT B additions (harness-local; production files untouched)
// ---------------------------------------------------------------------------

const FILE_OPS_SCHEMA_NOTE = [
  'file_ops params: {"operation": "read"|"write"|"move"|"list"|"delete", "path": string, "content": string (write only), "dest": string (move only)}',
  'The key is "operation" — never "action", "op_type", or any other name.',
].join("\n");

const APPROVAL_FLOW_LINE =
  "For gated operations (write/move/delete): emit the tool tag anyway. The system " +
  "intercepts it and routes it to the operator approval queue — emitting the tag IS " +
  "the disclosure. Do not refuse; do not describe the operation without emitting the tag.";

// ---------------------------------------------------------------------------
// Verbatim prompt extraction from production source
// ---------------------------------------------------------------------------

async function readSource(rel) {
  return fsp.readFile(path.join(REPO_ROOT, rel), "utf8");
}

function fail(msg) {
  console.error(`HARNESS ABORT: ${msg}`);
  process.exit(1);
}

/** Evaluate a captured JS literal (string-literal arrays / concatenations only).
 *  The captured text comes from our own repo source, not from model output. */
function evalLiteral(src, what) {
  try {
    return new Function(`return (${src});`)();
  } catch (e) {
    fail(`could not evaluate ${what} from source: ${e.message}`);
  }
}

/** Extract the production prompt PARTS so A and B can be assembled separately. */
async function extractProductionParts() {
  const chatTools = await readSource("lib/tools/chat-tools.ts");
  const subsets = await readSource("lib/persona-tool-subsets.ts");
  const registry = await readSource("lib/tools/registry.ts");

  const mech = chatTools.match(/const TOOL_MECHANICS = (\[[\s\S]*?\])\.join\("\\n"\)/);
  if (!mech) fail("TOOL_MECHANICS array not found in lib/tools/chat-tools.ts");
  const toolMechanics = evalLiteral(mech[1], "TOOL_MECHANICS").join("\n");

  const scoped = chatTools.match(/const SCOPED_SOURCE_GUIDANCE =([\s\S]*?";)\s*\n/);
  if (!scoped) fail("SCOPED_SOURCE_GUIDANCE not found in lib/tools/chat-tools.ts");
  const scopedGuidance = evalLiteral(scoped[1].replace(/;\s*$/, ""), "SCOPED_SOURCE_GUIDANCE");

  // Gated change (2026-06-09) lifted the Prompt B additions into production —
  // extract them too so --verify-production tests the REAL current surface.
  // Absent (pre-lift checkout) → null; --verify-production then aborts.
  const schemaM = chatTools.match(/const FILE_OPS_PARAMS_SCHEMA = (\[[\s\S]*?\])\.join\("\\n"\)/);
  const prodSchema = schemaM ? evalLiteral(schemaM[1], "FILE_OPS_PARAMS_SCHEMA").join("\n") : null;
  const approvalM = chatTools.match(/const APPROVAL_FLOW_NOTE =([\s\S]*?";)\s*\n/);
  const prodApproval = approvalM
    ? evalLiteral(approvalM[1].replace(/;\s*$/, ""), "APPROVAL_FLOW_NOTE")
    : null;

  const bobby = subsets.match(/bobby:\s*(\[[\s\S]*?\])/);
  if (!bobby) fail("bobby subset not found in lib/persona-tool-subsets.ts");
  const bobbyIds = evalLiteral(bobby[1], "bobby tool subset");

  const lines = [];
  for (const id of bobbyIds) {
    const entryStart = registry.indexOf(`id: "${id}"`);
    if (entryStart === -1) continue; // not registered → production drops it too
    const span = registry.slice(entryStart, registry.indexOf("execute:", entryStart));
    const desc = span.match(/description:\s*("(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*)/);
    if (!desc) fail(`description not extractable for tool "${id}" in registry.ts`);
    const description = evalLiteral(desc[1], `description of ${id}`);
    const ra = span.match(/requiresApproval:\s*([^,\n]+)/);
    const raVal = ra ? ra[1].trim() : "undefined";
    const gov =
      raVal === "true" ? "APPROVAL REQUIRED"
      : raVal === "false" || raVal === "undefined" ? "safe"
      : "approval (conditional)"; // identifier → function-valued in production
    lines.push(`- ${id} — ${description} [${gov}]`);
  }
  if (!lines.some((l) => l.startsWith("- file_ops"))) {
    fail("file_ops missing from the assembled tool list — wrong subset?");
  }
  return { toolMechanics, scopedGuidance, toolList: lines.join("\n"), prodSchema, prodApproval };
}

function assemblePromptA(p) {
  // Exact production assembly: buildToolAwarenessBlock(toolIds), scoped persona.
  return [p.toolMechanics, "", p.scopedGuidance, "", "Available tools:", p.toolList].join("\n");
}

/** The CURRENT production block — buildToolAwarenessBlock(bobby subset) as it
 *  exists in source NOW (post tool-call-enablement lift): mech, schema (bobby
 *  holds file_ops), approval note, scoped guidance, tool list. Verbatim by
 *  construction: every part is extracted from production source. */
function assembleProductionCurrent(p) {
  if (!p.prodSchema || !p.prodApproval) {
    fail(
      "--verify-production: FILE_OPS_PARAMS_SCHEMA / APPROVAL_FLOW_NOTE not found in " +
        "lib/tools/chat-tools.ts — is this a pre-lift checkout?"
    );
  }
  return [
    p.toolMechanics,
    "",
    p.prodSchema,
    "",
    p.prodApproval,
    "",
    p.scopedGuidance,
    "",
    "Available tools:",
    p.toolList,
  ].join("\n");
}

function assemblePromptB(p) {
  // Verbatim block + (1) file_ops params schema immediately after TOOL_MECHANICS
  // + (2) the approval-flow line. Everything else byte-identical to A.
  return [
    p.toolMechanics,
    "",
    FILE_OPS_SCHEMA_NOTE,
    "",
    APPROVAL_FLOW_LINE,
    "",
    p.scopedGuidance,
    "",
    "Available tools:",
    p.toolList,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation (parse-and-score only — NOTHING is executed)
// ---------------------------------------------------------------------------

const FABRICATION_PATTERNS = [
  /\bfile (?:has been|was|is now) (?:created|written|saved)\b/i,
  /\bsuccessfully (?:created|wrote|written|saved)\b/i,
  /\bI(?:'ve| have) (?:created|written|saved) (?:the |a )?file\b/i,
  /\bcreated the file\b/i,
  /\bwrote the file\b/i,
  /\bthe file now contains\b/i,
  /\bdone[.!]? the file\b/i,
];

function validateResponse(content) {
  const checks = {};
  const failureModes = [];

  const blocks = [...content.matchAll(/<tool\b[^>]*>([\s\S]*?)<\/tool>/gi)];
  const openTags = (content.match(/<tool\b[^>]*>/gi) ?? []).length;
  const closeTags = (content.match(/<\/tool>/gi) ?? []).length;

  checks.exactlyOneBlock = blocks.length === 1 && openTags === 1 && closeTags === 1;
  if (blocks.length === 0) failureModes.push(openTags || closeTags ? "orphan_tool_tag" : "no_tool_block");
  if (blocks.length > 1) failureModes.push("multiple_tool_blocks");
  if (blocks.length === 1 && (openTags !== 1 || closeTags !== 1)) failureModes.push("stray_extra_tag");

  let obj = null;
  if (blocks.length >= 1) {
    const inner = blocks[0][1].trim();
    try {
      obj = JSON.parse(inner);
      checks.jsonParses = true;
    } catch {
      checks.jsonParses = false;
      failureModes.push("bad_json");
    }
  } else {
    checks.jsonParses = false;
  }

  checks.idIsFileOps = obj?.id === "file_ops";
  if (obj && obj.id !== "file_ops") failureModes.push(`wrong_id:${String(obj.id ?? "(missing)")}`);

  const params = obj?.params && typeof obj.params === "object" ? obj.params : {};
  const op = String(params.operation ?? params.op ?? "");
  checks.operationIsWrite = op === "write";
  if (obj && op !== "write") failureModes.push(op ? `wrong_operation:${op}` : "missing_operation");

  checks.pathPresent = typeof params.path === "string" && params.path.trim().length > 0;
  if (obj && !checks.pathPresent) failureModes.push("missing_path");

  checks.contentPresent = typeof params.content === "string" && params.content.trim().length > 0;
  if (obj && !checks.contentPresent) failureModes.push("missing_content");

  const outside = content.replace(/<tool\b[^>]*>[\s\S]*?<\/tool>/gi, " ");
  const fab = FABRICATION_PATTERNS.map((p) => outside.match(p)?.[0]).filter(Boolean);
  checks.noFabricatedResult = fab.length === 0;
  if (fab.length > 0) failureModes.push(`fabricated_result(${fab[0]})`);

  if (/```/.test(content) && blocks.length === 0) failureModes.push("code_fence_instead_of_tag");
  // Hermes 3's native template uses <tool_call>…</tool_call>; OpenAI-style
  // models emit function_call / tool_calls. Both are format misses here, but
  // label them distinctly — they're diagnostic for the architecture fork.
  if (/<tool_call\b/i.test(content)) failureModes.push("hermes_native_tool_call_tag");
  if (/"function_call"|<function[=_]|\[TOOL_CALLS\]|tool_calls"/i.test(outside)) failureModes.push("native_style_call");

  // Bonus signal: would PRODUCTION's lenient brace-scanner (parseToolCalls,
  // v2.3.8 hardened — wrapper-independent) have executed a valid call anyway?
  let prodOk = false;
  for (const m of content.matchAll(/\{[^{}]*"id"\s*:\s*"file_ops"[\s\S]*?\}\s*\}/g)) {
    try {
      const o = JSON.parse(m[0]);
      const p = o?.params ?? {};
      if (
        o.id === "file_ops" &&
        String(p.operation ?? p.op ?? "") === "write" &&
        typeof p.path === "string" && p.path.trim() &&
        typeof p.content === "string" && p.content.trim()
      ) { prodOk = true; break; }
    } catch { /* keep scanning */ }
  }
  checks.prodLenientOk = prodOk;

  const clean =
    checks.exactlyOneBlock && checks.jsonParses && checks.idIsFileOps &&
    checks.operationIsWrite && checks.pathPresent && checks.contentPresent &&
    checks.noFabricatedResult;
  return { clean, checks, failureModes };
}

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

async function callOllama(model, systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        think: false, // production default (persona.think defaults false)
        options: { think: false, temperature: TEMPERATURE },
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `http_${res.status}: ${body.slice(0, 200)}`, latencyMs };
    }
    const json = await res.json();
    return { content: json?.message?.content ?? "", thinking: json?.message?.thinking ?? null, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - start;
    return { error: e?.name === "AbortError" ? "timeout" : `fetch_error: ${e.message}`, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

async function installedModels() {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) fail(`GET /api/tags → ${res.status}`);
  const json = await res.json();
  return new Set((json.models ?? []).map((m) => m.name));
}

async function loadExistingEvidence() {
  try {
    const raw = await fsp.readFile(EVIDENCE_PATH, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      // Round-1 records predate the variant tag → they were PROMPT A.
      .map((r) => ({ variant: "A", round: 1, ...r }));
  } catch {
    return [];
  }
}

async function runTrials(model, label, variant, systemPrompt, records) {
  const userPrompt = `Create a file at workspace/harness-test.txt containing the line: HARNESS_OK ${model}`;
  for (let trial = 1; trial <= TRIALS; trial++) {
    process.stdout.write(`[harness] ${model} [prompt ${variant}] trial ${trial}/${TRIALS} ... `);
    const r = await callOllama(model, systemPrompt, userPrompt);
    let verdict;
    let emptyThinking = false;
    if (r.error) {
      verdict = { clean: false, checks: {}, failureModes: [r.error] };
      console.log(`ERROR ${r.error} (${r.latencyMs} ms)`);
    } else {
      if (r.content.trim().length === 0 && r.thinking) emptyThinking = true;
      verdict = validateResponse(r.content);
      if (emptyThinking) verdict.failureModes.push("empty_content_thinking_only");
      console.log(`${verdict.clean ? "CLEAN" : `MALFORMED [${verdict.failureModes.join(", ") || "n/a"}]`} (${r.latencyMs} ms)`);
    }
    const record = {
      variant,
      round: 2,
      model,
      label,
      trial,
      latencyMs: r.latencyMs,
      error: r.error ?? null,
      raw: r.content ?? null,
      thinking: r.thinking ?? null,
      checks: verdict.checks,
      failureModes: verdict.failureModes,
      clean: verdict.clean,
    };
    records.push(record);
    await fsp.appendFile(EVIDENCE_PATH, JSON.stringify(record) + "\n", "utf8");
  }
}

async function main() {
  const parts = await extractProductionParts();

  // --verify-production: the post-lift verification gate. Runs ONLY the
  // production tool model against the CURRENT production prompt surface
  // (extracted from source, not a harness-local copy). Exit 1 unless 3/3 clean.
  if (process.argv.includes("--verify-production")) {
    const MODEL = "hermes3:8b";
    const prompt = assembleProductionCurrent(parts);
    console.log(`[harness] VERIFY-PRODUCTION: ${MODEL} vs current production block (${prompt.length} chars)`);
    const records = [];
    await runTrials(MODEL, "verify-production gate", "PROD", prompt, records);
    const clean = records.filter((r) => r.clean).length;
    // The FAITHFUL production gate is executability: the real v2.3.8 parser is
    // wrapper-independent, so a slightly malformed <tool> wrapper still executes
    // if the JSON tool-shape is valid (prodLenientOk mirrors that parser). Strict
    // clean-wrapper is reported too, but executability is what production needs.
    const executable = records.filter((r) => r.checks?.prodLenientOk).length;
    console.log(`\n[harness] verify-production: ${clean}/${TRIALS} strict-clean, ${executable}/${TRIALS} production-executable`);
    process.exit(executable === TRIALS ? 0 : 1);
  }

  // --batch-probe: Stage 1 — does hermes3 emit a clean file_ops BATCH op for a
  // multi-step request, against the current production block? Validates the
  // nested {operation:"batch", ops:[...]} shape. Exit 1 unless ≥2/3 clean.
  if (process.argv.includes("--batch-probe")) {
    const MODEL = "hermes3:8b";
    const prompt = assembleProductionCurrent(parts);
    const task =
      "Use file_ops to do BOTH of these in one step: create the folder " +
      "workspace/reports/2026, and move workspace/harness-test.txt into it.";
    console.log(`[harness] BATCH-PROBE: ${MODEL} vs current production block`);
    let cleanBatch = 0;
    for (let t = 1; t <= TRIALS; t++) {
      process.stdout.write(`[harness] ${MODEL} batch trial ${t}/${TRIALS} ... `);
      const r = await callOllama(MODEL, prompt, task);
      let ok = false, why = r.error ?? "no batch";
      if (!r.error) {
        const m = r.content.match(/<tool>([\s\S]*?)<\/tool>/i);
        try {
          const obj = m ? JSON.parse(m[1].trim()) : null;
          const ops = obj?.params?.ops;
          const opName = (obj?.params?.operation ?? obj?.params?.op ?? obj?.params?.action ?? "").toLowerCase();
          if (obj?.id === "file_ops" && opName === "batch" && Array.isArray(ops) && ops.length >= 2 &&
              ops.every((o) => typeof (o.operation ?? o.op ?? o.action) === "string" && typeof o.path === "string")) {
            ok = true; why = `${ops.length} ops: ${ops.map((o) => (o.operation ?? o.op ?? o.action)).join("+")}`;
          } else { why = `not a valid batch: ${m ? m[1].trim().slice(0, 120) : r.content.slice(0, 120)}`; }
        } catch { why = `bad json: ${(m ? m[1] : r.content).slice(0, 120)}`; }
      }
      if (ok) cleanBatch++;
      console.log(`${ok ? "BATCH-OK" : "MISS"} [${why}] (${r.latencyMs} ms)`);
    }
    console.log(`\n[harness] batch-probe: ${cleanBatch}/${TRIALS} clean batch emissions`);
    process.exit(cleanBatch >= 2 ? 0 : 1);
  }

  const promptA = assemblePromptA(parts);
  const promptB = assemblePromptB(parts);
  console.log(`[harness] PROMPT A (verbatim production): ${promptA.length} chars`);
  console.log(`[harness] PROMPT B (A + file_ops schema + approval-flow line): ${promptB.length} chars`);
  console.log(`[harness] temperature=${TEMPERATURE}, think=false; skipped: ${SKIPPED.join("; ")}`);

  const installed = await installedModels();
  const existing = await loadExistingEvidence();
  const all = [...existing];

  for (const { model, label } of CANDIDATES) {
    if (!installed.has(model)) {
      console.log(`[harness] SKIP ${model} — not installed`);
      continue;
    }
    const hasA = existing.some((r) => r.model === model && r.variant === "A" && !r.error);
    if (hasA) {
      console.log(`[harness] ${model} [prompt A] — carrying over round-1 results (no rerun)`);
    } else {
      await runTrials(model, label, "A", promptA, all);
    }
    await runTrials(model, label, "B", promptB, all);
  }

  // ---- Combined table across all rounds ----
  const rows = [];
  for (const { model, label } of CANDIDATES) {
    for (const variant of ["A", "B"]) {
      const recs = all.filter((r) => r.model === model && r.variant === variant);
      if (recs.length === 0) continue;
      const modes = new Map();
      for (const r of recs) for (const m of r.failureModes ?? []) modes.set(m, (modes.get(m) ?? 0) + 1);
      rows.push({
        model: model.length > 44 ? model.slice(0, 41) + "..." : model,
        prompt: variant,
        trials: recs.length,
        clean: recs.filter((r) => r.clean).length,
        prodOk: recs.filter((r) => r.checks?.prodLenientOk).length,
        failureModes: [...modes.entries()].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join("; ") || "—",
        avgLatencyMs: Math.round(recs.reduce((a, b) => a + b.latencyMs, 0) / recs.length),
      });
    }
  }

  console.log("\n=== COMBINED RESULTS — all rounds (strict scoring; prodOk = lenient v2.3.8 parser would execute) ===\n");
  console.table(rows);
  console.log(`Evidence: ${path.relative(REPO_ROOT, EVIDENCE_PATH)} (append-only; round-1 records untagged = prompt A)`);
  console.log(`Skipped: ${SKIPPED.join("; ")}`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
