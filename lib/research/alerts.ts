// lib/research/alerts.ts
//
// Phase 11 — Pushover alerts. Fire-and-forget POST to Pushover when
// a research report meets the alert criteria:
//
//   - quality === "SUFFICIENT" AND confidence >= threshold (default
//     0.8 per directive), OR
//   - any watchlist token appears in the summary, a finding, or a
//     citation (case-insensitive substring match)
//
// Pushover credentials live in settings (operatorPushoverUserKey +
// operatorPushoverApiToken). When either is missing, shouldAlert()
// still computes the criteria but sendAlert() short-circuits — keeps
// the criteria reasoning testable without keys.

import { readSettings } from "../settings";
import type { ResearchReport } from "./types";

const PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 8000;
const TWILIO_TIMEOUT_MS = 8000;

/** Criteria check — pure function over the report + settings. */
export interface AlertDecision {
  fire: boolean;
  reason: string; // human-readable explanation; included in audit logs
}

export function decideAlert(
  report: ResearchReport,
  watchlist: string[],
  confidenceThreshold: number
): AlertDecision {
  // Match watchlist first — operator-specified terms override the
  // confidence gate (lets them get alerted on partial / low-conf
  // results when a specific keyword fires).
  if (watchlist.length > 0) {
    const haystack = (
      report.summary +
      " " +
      report.findings.join(" ") +
      " " +
      report.citations.join(" ")
    ).toLowerCase();
    for (const w of watchlist) {
      const wl = w.toLowerCase().trim();
      if (wl.length > 0 && haystack.includes(wl)) {
        return {
          fire: true,
          reason: `watchlist match: "${w}"`,
        };
      }
    }
  }
  if (
    report.quality === "SUFFICIENT" &&
    report.confidenceScore >= confidenceThreshold
  ) {
    return {
      fire: true,
      reason: `quality SUFFICIENT + confidence ${report.confidenceScore.toFixed(2)} ≥ ${confidenceThreshold}`,
    };
  }
  return {
    fire: false,
    reason: `criteria not met (quality=${report.quality}, conf=${report.confidenceScore.toFixed(2)})`,
  };
}

/** Build the message body Pushover renders. Title + 1023-char body
 *  cap per Pushover API spec. */
function buildMessage(report: ResearchReport): {
  title: string;
  message: string;
  url?: string;
  url_title?: string;
} {
  const title = `[${report.intent}] ${report.quality} · conf ${report.confidenceScore.toFixed(2)}`;
  const lines: string[] = [];
  lines.push(report.summary);
  if (report.findings.length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const f of report.findings.slice(0, 3)) {
      lines.push(`• ${f}`);
    }
  }
  if (report.conflicts.length > 0) {
    lines.push("");
    lines.push("Conflicts:");
    for (const c of report.conflicts.slice(0, 2)) {
      lines.push(`! ${c}`);
    }
  }
  let message = lines.join("\n");
  if (message.length > 1023) message = message.slice(0, 1020) + "…";
  const topCitation = report.citations[0];
  // Top citation URL — Pushover renders this as a clickable "Open"
  // link. Extract the URL from the "[1] title — source — url" form.
  let url: string | undefined;
  if (topCitation) {
    const m = topCitation.match(/(https?:\/\/\S+)$/);
    if (m) url = m[1];
  }
  return {
    title,
    message,
    url,
    url_title: url ? "Top citation" : undefined,
  };
}

/** Build the form-encoded body for the Pushover POST. */
function formBody(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

/**
 * Low-level Pushover send primitive. Reads credentials from settings,
 * short-circuits cleanly when they're unset, and POSTs the message.
 * Fire-and-forget: never throws; logs on failure.
 *
 * Phase 10 Heartbeat (2026-05-31): extracted from sendAlert() so other
 * subsystems (the heartbeat dispatcher) reuse the EXACT same send path
 * — credential check, form encoding, timeout, error handling — without
 * re-implementing it. sendAlert() builds its research message and
 * delegates here.
 */
/** Raw Pushover POST. Assumes credentials are present. */
async function doPushoverPost(
  userKey: string,
  token: string,
  content: { title: string; message: string; url?: string; urlTitle?: string; priority?: string }
): Promise<{ sent: boolean; reason: string }> {
  const params = {
    token,
    user: userKey,
    title: content.title,
    message:
      content.message.length > 1023
        ? content.message.slice(0, 1020) + "…"
        : content.message,
    url: content.url,
    url_title: content.urlTitle,
    priority: content.priority ?? "0", // Pushover normal priority
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSHOVER_TIMEOUT_MS);
  try {
    const res = await fetch(PUSHOVER_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody(params),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.warn(`[research/alerts] Pushover HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return { sent: false, reason: `pushover ${res.status}` };
    }
    return { sent: true, reason: "alert delivered" };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/alerts] Pushover fetch failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return { sent: false, reason: `network: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Twilio SMS send primitive — mirrors pushoverSend's pattern (read creds
 * from settings, short-circuit cleanly when unset, POST, never throw).
 * Used as the fallback channel when Pushover is unavailable.
 *
 * `to` defaults to settings.twilioTo when omitted.
 */
export async function twilioSend(content: {
  to?: string;
  message: string;
}): Promise<{ sent: boolean; reason: string }> {
  const settings = await readSettings().catch(() => null);
  if (!settings) {
    return { sent: false, reason: "settings unreadable" };
  }
  const sid = settings.twilioAccountSid;
  const authToken = settings.twilioAuthToken;
  const from = settings.twilioFrom;
  const to = content.to ?? settings.twilioTo;
  if (!sid || !authToken || !from || !to) {
    return { sent: false, reason: "Twilio credentials not configured" };
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${authToken}`).toString("base64");
  // SMS hard cap is 1600 chars across segments; trim defensively.
  const smsBody =
    content.message.length > 1600 ? content.message.slice(0, 1597) + "…" : content.message;
  const body = formBody({ From: from, To: to, Body: smsBody });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${auth}`,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.warn(`[research/alerts] Twilio HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return { sent: false, reason: `twilio ${res.status}` };
    }
    return { sent: true, reason: "alert delivered via Twilio SMS" };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[research/alerts] Twilio fetch failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return { sent: false, reason: `twilio network: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notification primitive: try Pushover first, fall back to Twilio SMS.
 *
 *   - Pushover configured + send OK            → delivered (Pushover)
 *   - Pushover missing OR send fails, Twilio OK → delivered (Twilio SMS)
 *   - both fail / both missing                  → { sent:false, reason } (logged, never throws)
 *
 * Fire-and-forget: never throws. Reused by sendAlert (research) and the
 * dispatcher, so every alert path gets the same Pushover→Twilio fallback.
 */
export async function pushoverSend(content: {
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
  priority?: string;
}): Promise<{ sent: boolean; reason: string }> {
  const settings = await readSettings().catch(() => null);
  if (!settings) {
    return { sent: false, reason: "settings unreadable" };
  }

  // 1) Pushover (primary).
  let pushReason = "Pushover credentials not configured";
  const userKey = settings.operatorPushoverUserKey;
  const token = settings.operatorPushoverApiToken;
  if (userKey && token) {
    const r = await doPushoverPost(userKey, token, content);
    if (r.sent) return r; // delivered via Pushover
    pushReason = r.reason; // failed → try the fallback
  }

  // 2) Twilio SMS (fallback) — only when all four creds are present.
  const twilioReady =
    !!settings.twilioAccountSid &&
    !!settings.twilioAuthToken &&
    !!settings.twilioFrom &&
    !!settings.twilioTo;
  if (twilioReady) {
    const sms = await twilioSend({ message: `${content.title}\n${content.message}` });
    if (sms.sent) {
      return { sent: true, reason: `Pushover unavailable (${pushReason}); ${sms.reason}` };
    }
    return { sent: false, reason: `pushover: ${pushReason}; twilio: ${sms.reason}` };
  }

  // 3) No channel delivered.
  return { sent: false, reason: `${pushReason}; Twilio not configured` };
}

/**
 * Send a Pushover alert for a research report. Fire-and-forget:
 * never throws; logs on failure. Skips silently when keys are unset
 * (caller can still log the decision).
 *
 * Optional `forceTest` flag is used by the test-alert endpoint to
 * skip the criteria check.
 */
export async function sendAlert(
  report: ResearchReport,
  opts: { forceTest?: boolean; reasonOverride?: string } = {}
): Promise<{ sent: boolean; reason: string }> {
  const settings = await readSettings().catch(() => null);
  if (!settings) {
    return { sent: false, reason: "settings unreadable" };
  }

  // Criteria gate first (skipped for forceTest). Channel selection +
  // credential checks are delegated to pushoverSend, which now handles
  // the Pushover→Twilio fallback — so research alerts get SMS fallback
  // too, not just the dispatcher.
  if (!opts.forceTest) {
    const decision = decideAlert(
      report,
      settings.researchWatchlist,
      settings.researchAlertConfidenceThreshold
    );
    if (!decision.fire) {
      return { sent: false, reason: decision.reason };
    }
  }

  const body = buildMessage(report);
  const res = await pushoverSend({
    title: body.title,
    message: body.message,
    url: body.url,
    urlTitle: body.url_title,
    priority: "0",
  });
  // Preserve sendAlert's original contract: custom reason on success.
  if (res.sent) {
    return { sent: true, reason: opts.reasonOverride ?? res.reason };
  }
  return res;
}

/** Check whether Pushover is configured. Used by Tools UI to show
 *  status without exposing the keys. */
export async function isPushoverConfigured(): Promise<boolean> {
  try {
    const s = await readSettings();
    return (
      typeof s.operatorPushoverUserKey === "string" &&
      s.operatorPushoverUserKey.length > 0 &&
      typeof s.operatorPushoverApiToken === "string" &&
      s.operatorPushoverApiToken.length > 0
    );
  } catch {
    return false;
  }
}

/** Check whether the Twilio SMS fallback is fully configured (all four
 *  fields). Used by the Settings/Tools UI + the test-alert endpoint. */
export async function isTwilioConfigured(): Promise<boolean> {
  try {
    const s = await readSettings();
    return (
      !!s.twilioAccountSid &&
      !!s.twilioAuthToken &&
      !!s.twilioFrom &&
      !!s.twilioTo
    );
  } catch {
    return false;
  }
}
