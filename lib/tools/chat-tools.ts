// lib/tools/chat-tools.ts
//
// Tools Phase (2026-06-02) — the bridge between Bartimaeus's streamed replies
// and the tool executor.
//
//   Bart signals a tool by emitting:  <tool>{"id":"web_search","params":{…}}</tool>
//
// The chat route parses that, runs it through the governance executor, and
// (for safe tools) feeds the result back so Bart can continue. The tool-
// awareness block is injected into Bart's system prompt at the route level.

import { toolListForPrompt, getTool } from "./registry";
import type { ToolResult } from "./types";
// Single source of truth for display stripping — the hardened version also
// catches unclosed / orphan tool tags (see lib/chat-render.ts). Re-exported
// so existing server-side importers keep working unchanged.
import { stripToolTags } from "../chat-render";

export { stripToolTags };

export interface ParsedToolCall {
  id: string;
  params: Record<string, unknown>;
  raw: string;
}

/** A model output that LOOKED like a tool call but could not be executed —
 *  malformed JSON, unknown tool id, or an orphan tool tag with no JSON. These
 *  are AUDITED as parse_failed by the chat route so a tool-call attempt can
 *  never be silently lost (the v2.3.8 doctrine bug). */
export interface ToolParseFailure {
  raw: string;
  reason: string;
  toolId: string | null;
}

export interface ToolParseResult {
  calls: ParsedToolCall[];
  failures: ToolParseFailure[];
}

/** Extract the complete JSON object beginning at text[start] === "{".
 *  String- and brace-aware so braces inside string values (and nested objects
 *  like `"params":{...}`) don't truncate it. Returns [json, endExclusive] or
 *  null if the braces never balance. */
function extractJsonObject(text: string, start: number): [string, number] | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return [text.slice(start, i + 1), i + 1];
    }
  }
  return null;
}

/**
 * Parse tool calls from a model reply — HARDENED (v2.3.8).
 *
 * The old parser required a literal `<tool>...</tool>` wrapper. Models routinely
 * emit DEGRADED openers: `>{json}</tool>`, or a bare `{json}</tool>` with no
 * opener at all. The old regex silently rejected those → the call was lost, no
 * result injected, and on later turns the model fabricated success. THE
 * DOCTRINE BUG: fake success.
 *
 * This parser scans for JSON objects directly (brace-aware), independent of any
 * wrapper, and treats `{"id":"<KNOWN_TOOL>","params":...}` as a call wherever it
 * appears. Anything that looks like a tool-call attempt but isn't executable
 * (bad JSON, unknown tool, orphan tag) is returned as a FAILURE so the caller
 * can audit it. Never throws.
 */
export function parseToolCalls(text: string): ToolParseResult {
  const calls: ParsedToolCall[] = [];
  const failures: ToolParseFailure[] = [];
  if (!text) return { calls, failures };

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const ext = extractJsonObject(text, i);
    if (!ext) continue;
    const [jsonStr, end] = ext;
    // Only consider objects shaped like a tool call (have an "id" key).
    if (!/"id"\s*:/.test(jsonStr)) continue;

    // Is this object adjacent to a tool-tag marker? (<tool> before, a bare ">"
    // opener before, or </tool> after). Used only to decide whether a
    // NON-executable blob is a tool-call ATTEMPT worth flagging.
    const before = text.slice(Math.max(0, i - 16), i);
    const after = text.slice(end, end + 16);
    const tagged =
      /<tool\b[^>]*>\s*$/i.test(before) ||
      /(^|[^<])>\s*$/.test(before) ||
      /^\s*<\/tool>/i.test(after);

    let obj: { id?: unknown; params?: unknown } | null = null;
    try {
      obj = JSON.parse(jsonStr) as { id?: unknown; params?: unknown };
    } catch {
      obj = null;
    }

    if (obj && typeof obj.id === "string" && getTool(obj.id)) {
      // A real, registered tool — execute it regardless of how it was wrapped.
      calls.push({
        id: obj.id,
        params: obj.params && typeof obj.params === "object" ? (obj.params as Record<string, unknown>) : {},
        raw: jsonStr,
      });
      i = end - 1;
      continue;
    }

    // Not an executable call. Flag as an ATTEMPT only when it's clearly a
    // tool-call try (tagged, or carries a "params" key) — so legitimate JSON
    // the model merely discusses isn't logged as a failure.
    if (tagged || /"params"\s*:/.test(jsonStr)) {
      const reason =
        obj == null
          ? "invalid JSON in tool call"
          : typeof obj.id !== "string"
            ? "tool call missing string id"
            : `unknown tool id: ${String(obj.id)}`;
      failures.push({
        raw: jsonStr.slice(0, 2000),
        reason,
        toolId: obj && typeof obj.id === "string" ? obj.id : null,
      });
      i = end - 1;
    }
  }

  // Orphan tag markers with no parseable JSON anywhere (e.g. a lone "</tool>"
  // or "<tool>" the model emitted around text it never closed) — still an
  // attempt the system must not lose silently.
  if (calls.length === 0 && failures.length === 0 && /<\/?tool\b/i.test(text)) {
    const around = text.match(/[\s\S]{0,40}<\/?tool\b[^>]*>[\s\S]{0,40}/i);
    failures.push({
      raw: (around ? around[0] : text).slice(0, 2000).trim(),
      reason: "tool tag present but no parseable JSON tool call",
      toolId: null,
    });
  }

  return { calls, failures };
}

// Shared mechanics + governance + integrity — identical for every persona.
const TOOL_MECHANICS = [
  "TOOLS — you can ACT, not just advise.",
  "",
  "Use a tool ONLY when it genuinely helps the operator. Never use a tool for show.",
  "",
  "To use a tool, emit EXACTLY one tag in your reply:",
  '<tool>{"id":"<tool_id>","params":{ ... }}</tool>',
  "The system executes it and returns the result so you can continue your answer.",
  "",
  "GOVERNANCE — non-negotiable:",
  "- For any DANGEROUS tool (writes, deletes, sends, executes, or touches an external",
  "  system) you MUST first DISCLOSE, in plain words: what the tool will do, what could",
  "  go wrong, and whether it is reversible. The operator approves before it runs.",
  "- Use at most one tool per reply.",
  "- You may ONLY call tools from the 'Available tools' list below. If a task needs a",
  "  tool you do not have, say so plainly and (if useful) suggest the operator ask",
  "  Bartimaeus, who holds the full tool set. NEVER invent a tool, and NEVER report a",
  "  result for a tool you did not actually call.",
  "",
  "CRITICAL TOOL RULE: When a tool returns results, you MUST answer the operator's " +
    "question directly using those results FIRST. Do not question the tool methodology. " +
    "Do not philosophize about reliability. Read the result. Answer the question. One " +
    "sentence answer. Then you may add commentary. Web search results are authoritative " +
    "for current facts. If web_search returns a current president, that IS the current " +
    "president. Use it.",
].join("\n");

// Tool-call enablement (2026-06-09) — both blocks lifted VERBATIM from the
// round-2 harness Prompt B after A/B evidence (scripts/harness-evidence.jsonl):
// across 5 models the verbatim block scored 1/15 clean; adding these two
// scored 11/15. The dominant malform was an invented params key ("action") —
// the schema was never specified anywhere in the prompt — and gated ops
// stalled on disclose-without-emitting (Orchestrator refused 3/3 without the
// approval-flow note, emitted 3/3 clean with it).
const FILE_OPS_PARAMS_SCHEMA = [
  'file_ops params: {"operation": "read"|"write"|"move"|"copy"|"mkdir"|"list"|"delete", "path": string, "content": string (write only), "dest": string (move/copy only)}',
  'The key is "operation" — never "action", "op_type", or any other name.',
  'For MULTIPLE file operations in one request, emit ONE batch call (not several tags):',
  '{"id":"file_ops","params":{"operation":"batch","ops":[{"operation":"mkdir","path":"reports/2026"},{"operation":"move","path":"x.txt","dest":"reports/2026/x.txt"}]}}',
  "The operator approves the whole batch once, after reviewing the manifest.",
].join("\n");

const APPROVAL_FLOW_NOTE =
  "For gated operations (write/move/delete): emit the tool tag anyway. The system " +
  "intercepts it and routes it to the operator approval queue — emitting the tag IS " +
  "the disclosure. Do not refuse; do not describe the operation without emitting the tag.";

// Bart-only rich source-routing guidance (references the full tool set).
const FULL_SOURCE_GUIDANCE = [
  "FACTUAL QUERIES — chain_search_to_read FIRST. For factual questions about people, " +
    "companies, or current events: use chain_search_to_read FIRST. It searches AND reads " +
    "pages. web_search alone returns shallow snippets that often don't contain the answer. " +
    "Only use web_search alone for navigational queries where you just need URLs. If " +
    "chain_search_to_read returns nothing useful, then try specialized tools " +
    "(wikipedia_search for entities, arxiv_search for research, gdelt_events for events, " +
    "sec_edgar for public companies).",
  "",
  "WHEN TO USE WHICH SOURCE (web knowledge):",
  "- Most factual questions → chain_search_to_read (searches + reads; THE default).",
  "- General current events / facts → searxng_search (aggregates many engines, DDG fallback).",
  "- A specific page's content → jina_reader (clean markdown) or firecrawl_alt (structured).",
  "- Entities / people / places / concepts → wikipedia_search (prose) + wikidata_query (structured facts).",
  "- AI / ML / research papers → arxiv_search + papers_with_code; broaden with openalex_search.",
  "- Academic metadata / DOI → crossref_lookup. Medical / biology → pubmed_search.",
  "- Models / datasets → huggingface_hub.",
  "- Global news / current events → gdelt_events.",
  "- Weather / temperature / forecast → open_meteo_weather (pass the place name as `location`).",
  "- Code / dev / errors → github_search + stackexchange_search.",
  "- Public companies (filings, CEO, financials) → sec_edgar (+ wikipedia_search).",
  "- A specific page's content → web_crawl. Open-ended digging → deep_research.",
  "Always cite the source URL. State result freshness when it matters.",
].join("\n");

// Concise guidance for scoped personas (avoids naming tools they don't hold).
const SCOPED_SOURCE_GUIDANCE =
  "Pick the tool from your list that best fits the task. For most factual lookups, " +
  "chain_search_to_read (if you have it) searches AND reads pages; web_search returns " +
  "snippets. Always cite the source. State freshness when it matters.";

/**
 * The tool-awareness block added to a persona's system prompt at the route
 * level. v2.3.11: pass `toolIds` to scope the block to a persona's subset.
 * No argument → the FULL block (Bartimaeus; unchanged behavior).
 */
export function buildToolAwarenessBlock(toolIds?: string[]): string {
  const guidance = toolIds ? SCOPED_SOURCE_GUIDANCE : FULL_SOURCE_GUIDANCE;
  // The file_ops schema is included only when the persona actually holds
  // file_ops (Bart's full set, or a scoped subset containing it) — a schema
  // for an unheld tool invites out-of-scope calls. The approval-flow note is
  // universal: every persona has at least one gated tool shape.
  const hasFileOps = !toolIds || toolIds.includes("file_ops");
  return [
    TOOL_MECHANICS,
    "",
    ...(hasFileOps ? [FILE_OPS_PARAMS_SCHEMA, ""] : []),
    APPROVAL_FLOW_NOTE,
    "",
    guidance,
    "",
    "Available tools:",
    toolListForPrompt(toolIds),
  ].join("\n");
}

/** Prompt fed back to Bart so he continues with the tool result in hand. */
export function continuationPrompt(toolId: string, result: ToolResult): string {
  const dataStr = result.data ? JSON.stringify(result.data).slice(0, 1500) : "";
  return [
    `[Tool result — ${toolId} — ${result.ok ? "ok" : "FAILED"}]`,
    result.summary,
    dataStr,
    result.error ? `Error: ${result.error}` : "",
    "",
    "Answer the operator's question directly using this result FIRST — one sentence, " +
      "stated plainly. Treat web results as authoritative for current facts; do not " +
      "question the methodology. Then add at most one line of commentary. Do not emit " +
      "another tool tag.",
  ]
    .filter(Boolean)
    .join("\n");
}
