// lib/tools/email-read.ts
//
// Stage 3 (2026-06-09) — READ-ONLY email tool. operations: list | read |
// search. Read-only is enforced at the credential level (gmail.readonly) AND
// here (no send/delete/modify operation exists). Every body/subject/sender is
// run through the injection guards (untrusted envelope + tool-tag
// neutralization) before it can enter model context; injection attempts are
// audited as email.injection_attempt with the source message id.
//
// Safe tool (read) → ungated. But once an email tool result is in a turn's
// context, the chat route's email_context_gate forces approval on ANY further
// tool op (Guard 3), and the route strips email content from cloud turns
// regardless of cloudDataPolicy (Guard 4).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { appendAudit } from "../audit";
import { getEmailProvider } from "../email/provider";
import { wrapUntrustedEmails, type EmailMessageView } from "../email/guards";

export const ID = "email_read";

const OPS = new Set(["list", "read", "search"]);

function op(params: Record<string, unknown>): string {
  return String(params.operation ?? params.op ?? params.action ?? "").toLowerCase();
}

export function validate(params: Record<string, unknown>): { ok: boolean; error?: string } {
  const o = op(params);
  if (!OPS.has(o)) return { ok: false, error: `unknown operation "${o}" (list|read|search)` };
  if (o === "read") {
    const id = String(params.id ?? params.messageId ?? "").trim();
    if (!id) return { ok: false, error: "read requires a message id" };
  }
  if (o === "search") {
    const q = String(params.query ?? "").trim();
    if (!q) return { ok: false, error: "search requires a query" };
  }
  return { ok: true };
}

async function auditInjections(attempts: Array<{ id: string; reason: string }>): Promise<void> {
  for (const a of attempts) {
    await appendAudit("email.injection_attempt", { messageId: a.id, reason: a.reason }).catch(() => {});
  }
}

export const execute: ToolExecute = async (params) => {
  const o = op(params);
  const v = validate(params);
  if (!v.ok) return toolErr(ID, v.error ?? "invalid email operation");

  const pr = await getEmailProvider();
  if (!pr.ok) return toolErr(ID, pr.error);

  try {
    let messages: EmailMessageView[] = [];
    let label = "";
    if (o === "list") {
      const max = Number(params.max ?? 25);
      const query = params.query != null ? String(params.query) : "in:inbox";
      messages = await pr.provider.list({ query, max });
      label = `${messages.length} message(s) (${pr.mode})`;
    } else if (o === "search") {
      const max = Number(params.max ?? 25);
      messages = await pr.provider.search(String(params.query), max);
      label = `${messages.length} match(es) for "${String(params.query)}" (${pr.mode})`;
    } else {
      const id = String(params.id ?? params.messageId ?? "").trim();
      const m = await pr.provider.read(id);
      if (!m) return toolErr(ID, `message not found: ${id}`);
      messages = [m];
      label = `message ${id} (${pr.mode})`;
    }

    // Guards 1 + 2: wrap in the untrusted envelope, neutralize tool syntax,
    // collect injection attempts.
    const wrapped = wrapUntrustedEmails(messages);
    await auditInjections(wrapped.injectionAttempts);

    return toolOk(ID, label, {
      data: {
        // The wrapped, neutralized envelope IS the email content that enters
        // context. Carries EMAIL_CONTENT_MARKER → route Guards 3 + 4 key on it.
        emailContext: wrapped.block,
        // Metadata only (no raw body) for the result card.
        messages: messages.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date })),
        injectionAttempts: wrapped.injectionAttempts,
        readOnly: true,
      },
    });
  } catch (e) {
    return toolErr(ID, `${o} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
