// lib/chat-render.ts
//
// Pure, dependency-free helpers for rendering assistant chat output cleanly.
// NO server imports (no node:fs, no registry) — safe to import from the
// client ChatPane AND from a diagnostic route / smoke. Single source of truth
// for two cleanups (2026-06-02):
//
//   1. stripToolTags  — remove Bart's <tool>{json}</tool> control tags from
//      the visible answer. The tool RESULT card already shows what ran; the
//      raw tag is redundant noise. Hardened to also catch unclosed tags
//      (mid-stream / model forgot to close) and orphan fragments.
//
//   2. splitReasoning — pull internal monologue out of the answer into a
//      separate "Reasoning" panel. Handles <think>…</think> blocks AND the
//      labeled-prose form Bart's model emits without tags
//      ("Self-Correction:", "Internal Monologue:", …).

/**
 * Remove tool-call control tags from text shown to the operator.
 *
 * Covers, case-insensitively:
 *   - complete  <tool>…</tool>  (and <tool_call>/<tool_use> variants, with attrs)
 *   - the JSON blob itself, with NO <tool> wrapper and an optional stray '>'
 *     prefix — the observed leak: >{"id":"chain_search_to_read","params":{…}}
 *   - unclosed  <tool>…         running to end of text (streaming / unterminated)
 *   - orphan    </tool> or <tool …>  fragments left over
 */
export function stripToolTags(content: string): string {
  if (!content) return "";
  return content
    // complete pairs, optional attributes + underscore variants
    .replace(/<tool(?:_call|_use)?\b[^>]*>[\s\S]*?<\/tool(?:_call|_use)?>/gi, "")
    // tool-call JSON blob with optional <tool> wrapping and/or a stray leading
    // '>' (the observed leak format). Matches {"id":"<toolid>","params":{…}}
    // (params is one nested object). Handles >{…}, <tool>{…}, {…}</tool>, {…}.
    .replace(
      /(?:<\/?tool(?:_call|_use)?\b[^>]*>|[<>])*\s*\{\s*["']?id["']?\s*:\s*["'][\w.\-]+["']\s*,\s*["']?params["']?\s*:\s*\{[\s\S]*?\}\s*\}(?:\s*<\/?tool(?:_call|_use)?\b[^>]*>)?/gi,
      ""
    )
    // unclosed open tag → strip to end (a broken tag has no clean answer after it)
    .replace(/<tool(?:_call|_use)?\b[^>]*>[\s\S]*$/gi, "")
    // orphan open/close fragments
    .replace(/<\/?tool(?:_call|_use)?\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SplitContent {
  /** The clean answer with reasoning removed. */
  answer: string;
  /** Extracted internal reasoning, or null if none was found. */
  reasoning: string | null;
}

// Meta-cognition headers the model emits inline without <think> tags. Kept
// deliberately tight (the operator named "Self-Correction" + "Internal
// Monologue") plus unambiguous CoT synonyms — NOT "Analysis", which Sage uses
// as a legitimate answer section.
const MONOLOGUE_LABEL =
  "(?:Self[-\\s]?Correction(?:\\s*\\/\\s*Internal\\s+Monologue)?|Internal\\s+Monologue|Chain[-\\s]?of[-\\s]?Thought|Thought\\s+Process|Reasoning|Deliberation|Scratchpad)";

// A labeled block: line-start, optional markdown decoration, the label, a
// colon, then content up to the next blank line (paragraph break) or end.
const LABEL_BLOCK_RE = new RegExp(
  `(?:^|\\n)[ \\t>*_#\`]*${MONOLOGUE_LABEL}[ \\t]*:[\\s\\S]*?(?=\\n[ \\t]*\\n|$)`,
  "gi"
);

/**
 * Separate internal reasoning from the answer.
 *
 * Extraction order:
 *   1. complete <think>…</think> blocks
 *   2. an unclosed <think>… running to end (streaming / unterminated)
 *   3. labeled monologue blocks emitted without tags
 *
 * Guard: if extraction would leave an EMPTY answer (the whole message was
 * reasoning), we keep the original text as the answer and surface no panel —
 * the operator never loses the message body.
 */
export function splitReasoning(content: string): SplitContent {
  if (!content) return { answer: "", reasoning: null };
  const parts: string[] = [];
  let text = content;

  // 1) complete <think>…</think>
  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
    const t = String(inner).trim();
    if (t) parts.push(t);
    return "";
  });

  // 2) unclosed <think>… to end
  text = text.replace(/<think>([\s\S]*)$/i, (_m, inner) => {
    const t = String(inner).trim();
    if (t) parts.push(t);
    return "";
  });

  // 3) labeled monologue blocks
  LABEL_BLOCK_RE.lastIndex = 0;
  text = text.replace(LABEL_BLOCK_RE, (m) => {
    const t = m.trim();
    if (t) parts.push(t);
    return "";
  });

  const answer = text.replace(/\n{3,}/g, "\n\n").trim();
  const reasoning = parts.length ? parts.join("\n\n").trim() : "";

  // Never blank the whole message: if the entire reply was reasoning (no
  // answer remained), promote the reasoning to the visible answer and drop the
  // panel — shown inline, with tags/labels already stripped.
  if (!answer && reasoning) {
    return { answer: reasoning, reasoning: null };
  }
  return { answer, reasoning: reasoning || null };
}
