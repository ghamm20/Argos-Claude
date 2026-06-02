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

import { toolListForPrompt } from "./registry";
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

const TOOL_TAG_RE = /<tool>\s*([\s\S]*?)\s*<\/tool>/gi;

/** Parse all <tool>{json}</tool> calls from a model reply. Malformed JSON is
 *  skipped (never throws). */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let m: RegExpExecArray | null;
  TOOL_TAG_RE.lastIndex = 0;
  while ((m = TOOL_TAG_RE.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as { id?: string; params?: Record<string, unknown> };
      if (obj && typeof obj.id === "string") {
        calls.push({ id: obj.id, params: obj.params ?? {}, raw: m[0] });
      }
    } catch {
      /* not valid JSON — skip */
    }
  }
  return calls;
}

/** The tool-awareness block prepended/added to Bartimaeus's system prompt. */
export function buildToolAwarenessBlock(): string {
  return [
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
    "",
    "CRITICAL TOOL RULE: When a tool returns results, you MUST answer the operator's " +
      "question directly using those results FIRST. Do not question the tool methodology. " +
      "Do not philosophize about reliability. Read the result. Answer the question. One " +
      "sentence answer. Then you may add commentary. Web search results are authoritative " +
      "for current facts. If web_search returns a current president, that IS the current " +
      "president. Use it.",
    "",
    "WHEN TO USE WHICH SOURCE (web knowledge):",
    "- General current events / facts → searxng_search (PRIMARY; aggregates many engines, DDG fallback).",
    "- Entities / people / places / concepts → wikipedia_search (prose) + wikidata_query (structured facts).",
    "- AI / ML / research papers → arxiv_search + papers_with_code; broaden with openalex_search.",
    "- Academic metadata / DOI → crossref_lookup. Medical / biology → pubmed_search.",
    "- Models / datasets → huggingface_hub.",
    "- Global news / current events → gdelt_events.",
    "- Code / dev / errors → github_search + stackexchange_search.",
    "- Public companies (filings, CEO, financials) → sec_edgar (+ wikipedia_search).",
    "- A specific page's content → web_crawl. Open-ended digging → deep_research.",
    "Always cite the source URL. State result freshness when it matters.",
    "",
    "Available tools:",
    toolListForPrompt(),
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
