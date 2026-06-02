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

/** Remove all tool tags from displayed text (used client-side). */
export function stripToolTags(text: string): string {
  return text.replace(TOOL_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
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
    "Continue your reply to the operator using this result. Do not emit another tool tag.",
  ]
    .filter(Boolean)
    .join("\n");
}
