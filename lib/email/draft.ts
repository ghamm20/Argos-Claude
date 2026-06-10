// lib/email/draft.ts
//
// Stage 14 (2026-06-09) — email DRAFT-CREATE. DRAFTS-ONLY is an ABSOLUTE,
// PERMANENT ceiling: there is NO send capability in code, not even stubbed.
// A draft is composed and saved LOCALLY (state/drafts/) for the operator to
// review and send manually from their own client. ARGOS never holds a Gmail
// send/compose scope (it is gmail.readonly), so it CANNOT send even if asked.
//
// Injection guards apply to any source email being replied to: its content is
// UNTRUSTED — neutralized + enveloped — and the draft composition NEVER follows
// instructions found inside it (template-based v1, deterministic).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";
import { getEmailProvider } from "../email/provider";
import { wrapUntrustedEmails, neutralizeToolSyntax } from "../email/guards";

export function draftsDir(): string {
  return path.join(argosRoot(), "state", "drafts");
}

export interface EmailDraft {
  id: string;
  at: string;
  to: string;
  subject: string;
  body: string;
  replyToId: string | null;
  /** True if a source email was neutralized into this draft's context. */
  sourceNeutralized: boolean;
  /** ALWAYS false. Drafts are never sent by ARGOS — local artifact only. */
  sent: false;
}

export interface CreateDraftInput {
  to?: string;
  subject?: string;
  /** A short hint for the body; treated as OPERATOR intent, not email content. */
  bodyHint?: string;
  /** Optional source email id to draft a reply to (from the live/synthetic box). */
  replyToId?: string;
}

/**
 * Compose a draft and save it locally. NEVER sends. If replyToId is given, the
 * source email is fetched, run through the injection guards, and referenced —
 * but its content is DATA: the draft is a neutral acknowledgment template, never
 * an execution of anything the email asked for.
 */
export async function createDraft(input: CreateDraftInput): Promise<{ ok: boolean; draft?: EmailDraft; error?: string; injectionAttempts?: number }> {
  const at = new Date().toISOString();
  let to = (input.to ?? "").trim();
  let subject = (input.subject ?? "").trim();
  let sourceNeutralized = false;
  let injectionAttempts = 0;

  if (input.replyToId) {
    const provider = await getEmailProvider();
    if (!provider.ok) {
      await appendAudit("email_gate_deferred", { stage: "draft_create", reason: provider.error }).catch(() => {});
    } else {
      const src = await provider.provider.read(input.replyToId).catch(() => null);
      if (src) {
        const wrapped = wrapUntrustedEmails([src]); // neutralize + envelope
        injectionAttempts = wrapped.injectionAttempts.length;
        for (const a of wrapped.injectionAttempts) {
          await appendAudit("email.injection_attempt", { stage: "draft_create", messageId: a.id, reason: a.reason }).catch(() => {});
        }
        // Reference the source ONLY via neutralized fields; never copy its body
        // verbatim into the draft (and never act on it).
        to = to || neutralizeToolSyntax(src.from ?? "").sanitized;
        subject = subject || `Re: ${neutralizeToolSyntax(src.subject ?? "").sanitized}`;
        sourceNeutralized = true;
      }
    }
  }

  if (!to) return { ok: false, error: "draft requires a recipient (to) or a resolvable replyToId" };

  // Template body — NEUTRAL by construction. The operator's bodyHint is included
  // as their intent; email content is NEVER used as an instruction.
  const hint = neutralizeToolSyntax(input.bodyHint ?? "").sanitized;
  const body = [
    "Hi,",
    "",
    hint || "Thank you for your message — I'll follow up shortly.",
    "",
    "[DRAFT — composed by ARGOS for operator review. Not sent. Review and send manually.]",
  ].join("\n");

  const draft: EmailDraft = {
    id: `d_${randomUUID().slice(0, 8)}`,
    at, to, subject: subject || "(no subject)", body,
    replyToId: input.replyToId ?? null, sourceNeutralized, sent: false,
  };

  await fsp.mkdir(draftsDir(), { recursive: true });
  await fsp.writeFile(path.join(draftsDir(), `${draft.id}.json`), JSON.stringify(draft, null, 2), "utf8");
  await appendAudit("email.draft_created", { draftId: draft.id, to: draft.to, subject: draft.subject, replyToId: draft.replyToId, sent: false }).catch(() => {});

  return { ok: true, draft, injectionAttempts };
}

export async function listDrafts(): Promise<EmailDraft[]> {
  try {
    const names = (await fsp.readdir(draftsDir())).filter((n) => n.endsWith(".json"));
    const out: EmailDraft[] = [];
    for (const n of names) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(draftsDir(), n), "utf8")) as EmailDraft); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}
