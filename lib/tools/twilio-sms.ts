// lib/tools/twilio-sms.ts — T10 SMS via Twilio (approval, NOT reversible)
//
// Reuses the existing twilioSend() with the operator's configured Twilio
// credentials. Sending is irreversible → requires approval.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { twilioSend } from "../research/alerts";

export const ID = "twilio_sms";

export const execute: ToolExecute = async (params) => {
  const message = String(params.message ?? "").trim();
  const to = typeof params.to === "string" ? params.to.trim() : undefined;
  if (!message) return toolErr(ID, "message is required");
  const r = await twilioSend({ to, message });
  if (!r.sent) {
    return toolErr(ID, `not sent: ${r.reason}`);
  }
  return toolOk(ID, `SMS sent (${r.reason})`, {
    data: { to: to ?? "(default)", message, reason: r.reason },
  });
};
