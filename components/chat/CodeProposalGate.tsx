// components/chat/CodeProposalGate.tsx
//
// Bobby v2 (2026-05-27) — in-chat approval gate for agentic-coder
// proposals.
//
// Renders under any assistant message from Bobby that contains a
// fenced code block. Two buttons:
//
//   - "Approve & Run" → copies the extracted code to the system
//     clipboard. ARGOS NEVER executes the code itself. The operator
//     runs it manually (terminal, IDE, wherever). This preserves the
//     hard security boundary: ARGOS proposes, operator executes.
//
//   - "Reject"        → emits a canonical rejection string back through
//     the chat (via onReject prop). Bobby's next turn sees the
//     rejection in context and offers an alternative.
//
// Doctrine: this component is the LAST line of defense against an
// agentic model running ad-hoc code on the operator's machine. It must
// stay dumb-on-purpose — no eval(), no spawn(), no exec(), no fetch
// to a runner endpoint. Copy text. That is the whole API.

"use client";

import { useCallback, useState } from "react";
import { Check, X, Copy, Loader2 } from "lucide-react";

/**
 * Pull fenced code blocks (```lang ... ```) out of markdown content.
 * Concatenates multiple blocks with a blank line between them so the
 * operator gets the full proposal in one paste. Returns null if there
 * are no non-empty code blocks (the gate then renders nothing).
 *
 * Strips the language tag (e.g. ```python) — we copy the raw source,
 * not the markdown fence.
 *
 * Exported so the parent can decide whether to render the gate at all
 * (avoids mounting a no-op component on every Bobby turn).
 */
export function extractCodeBlocks(content: string): string | null {
  // [\s\S] instead of . because . doesn't span newlines without /s flag,
  // and /s isn't universally supported in our TS target. Non-greedy.
  const re = /```(?:[a-zA-Z0-9_+\-.]*)\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1];
    if (body && body.trim().length > 0) blocks.push(body);
  }
  if (blocks.length === 0) return null;
  return blocks.join("\n\n").trim();
}

/** Canonical text sent back to Bobby when the operator rejects a
 *  proposal. Exported so ChatPane and any test harness can assert
 *  the exact text without re-typing it. */
export const REJECT_PROMPT_TEXT =
  "Operator rejected the previous proposal. Please offer an alternative approach.";

type GateState = "idle" | "copying" | "approved" | "rejected";

interface CodeProposalGateProps {
  /** Full message content — we extract code blocks ourselves. */
  content: string;
  /** Persona accent color (Bobby is blue #3b82f6) for button skinning. */
  accent: string;
  /** Called with REJECT_PROMPT_TEXT when the operator clicks Reject. */
  onReject: (rejectionText: string) => void;
}

export function CodeProposalGate({
  content,
  accent,
  onReject,
}: CodeProposalGateProps) {
  const code = extractCodeBlocks(content);
  const [state, setState] = useState<GateState>("idle");

  const onApprove = useCallback(async () => {
    if (!code) return;
    setState("copying");
    // navigator.clipboard requires a secure context (https or localhost).
    // ARGOS runs on http://127.0.0.1 — which the clipboard API treats
    // as secure. Defensive fallback below for any browser that disagrees.
    try {
      await navigator.clipboard.writeText(code);
      setState("approved");
      return;
    } catch {
      /* fall through to legacy path */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setState("approved");
    } catch {
      // Both paths failed — revert to idle so the operator can retry
      // or copy by hand from the code block above.
      setState("idle");
    }
  }, [code]);

  const onRejectClick = useCallback(() => {
    setState("rejected");
    onReject(REJECT_PROMPT_TEXT);
  }, [onReject]);

  if (!code) return null;

  if (state === "approved") {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-400">
        <Check className="h-3 w-3" style={{ color: accent }} />
        <span>Copied to clipboard — ready to run manually.</span>
      </div>
    );
  }

  if (state === "rejected") {
    return (
      <div className="mt-2 text-[11px] text-neutral-500 italic">
        Proposal rejected. Asking Bobby for an alternative…
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        onClick={() => void onApprove()}
        disabled={state === "copying"}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border transition-colors disabled:opacity-50"
        style={{
          color: accent,
          borderColor: `${accent}60`,
          background: `${accent}10`,
        }}
        title="Copy code to clipboard. ARGOS does not execute — you run it manually."
      >
        {state === "copying" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        Approve &amp; Run
      </button>
      <button
        type="button"
        onClick={onRejectClick}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border border-neutral-700/60 text-neutral-400 hover:bg-neutral-800/60 transition-colors"
        title="Reject this proposal and ask Bobby for an alternative."
      >
        <X className="h-3 w-3" />
        Reject
      </button>
    </div>
  );
}
