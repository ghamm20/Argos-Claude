// lib/tools/pushover-alert.ts — T9 Pushover Alert (approval, NOT reversible)
//
// Reuses the existing pushoverSend() (Pushover→Twilio fallback). Sending is
// irreversible, so this requires operator approval.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { pushoverSend } from "../research/alerts";

export const ID = "pushover_alert";

const PRIORITY: Record<string, string> = {
  low: "-1",
  normal: "0",
  high: "1",
  emergency: "2",
};

export const execute: ToolExecute = async (params) => {
  const title = String(params.title ?? "ARGOS Alert").trim() || "ARGOS Alert";
  const message = String(params.message ?? "").trim();
  const priorityKey = String(params.priority ?? "normal").toLowerCase();
  if (!message) return toolErr(ID, "message is required");
  const priority = PRIORITY[priorityKey] ?? "0";
  const r = await pushoverSend({ title, message, priority });
  if (!r.sent) {
    return toolErr(ID, `not sent: ${r.reason}`);
  }
  return toolOk(ID, `alert sent (${r.reason})`, {
    data: { title, message, priority: priorityKey, reason: r.reason },
  });
};
