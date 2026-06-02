// lib/tools/email-draft.ts — T8 Email Draft (approval, reversible)
//
// Writes a draft to ARGOS_ROOT/output/email-<ts>.md. Does NOT send.

import path from "node:path";
import { toolOk, toolErr, type ToolExecute } from "./types";
import { writeOutputFile } from "./util";

export const ID = "email_draft";

const TONES = new Set(["formal", "aggressive", "neutral"]);

export const execute: ToolExecute = async (params) => {
  const to = String(params.to ?? "").trim();
  const subject = String(params.subject ?? "").trim();
  const body = String(params.body ?? "").trim();
  const tone = String(params.tone ?? "neutral").toLowerCase();
  if (!to || !subject || !body) {
    return toolErr(ID, "to, subject, and body are required");
  }
  const toneLabel = TONES.has(tone) ? tone : "neutral";
  const md = [
    "# Email draft",
    "",
    `**To:** ${to}`,
    `**Subject:** ${subject}`,
    `**Tone:** ${toneLabel}`,
    `**Status:** DRAFT — not sent`,
    "",
    "---",
    "",
    body,
    "",
  ].join("\n");
  try {
    const filePath = await writeOutputFile(`email-${subject}`, "md", md);
    return toolOk(ID, `drafted email to ${to} → ${path.basename(filePath)}`, {
      data: { path: filePath, to, subject, tone: toneLabel, sent: false },
    });
  } catch (e) {
    return toolErr(ID, `write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
