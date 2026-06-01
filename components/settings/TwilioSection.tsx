// components/settings/TwilioSection.tsx
//
// Task 5 (2026-05-31) — Settings panel for the Twilio SMS fallback
// channel. When Pushover is unavailable (unset or a failed send) and all
// four Twilio fields are present, ARGOS alerts fall back to an SMS.
//
// Reads/writes the four creds via GET/POST /api/settings (twilioAccountSid,
// twilioAuthToken, twilioFrom, twilioTo). "Send test alert" fires
// POST /api/research/alert/test, which now succeeds via either channel.
//
// Mirrors HeartbeatSection's structure + styling.

"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, AlertCircle, Save, Send } from "lucide-react";

interface TwilioFields {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFrom: string;
  twilioTo: string;
}

const EMPTY: TwilioFields = {
  twilioAccountSid: "",
  twilioAuthToken: "",
  twilioFrom: "",
  twilioTo: "",
};

export function TwilioSection() {
  const [fields, setFields] = useState<TwilioFields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as Partial<TwilioFields>;
      setFields({
        twilioAccountSid: j.twilioAccountSid ?? "",
        twilioAuthToken: j.twilioAuthToken ?? "",
        twilioFrom: j.twilioFrom ?? "",
        twilioTo: j.twilioTo ?? "",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSavedNote(null);
    try {
      // Empty string → null (clears the credential).
      const body = {
        twilioAccountSid: fields.twilioAccountSid.trim() || null,
        twilioAuthToken: fields.twilioAuthToken.trim() || null,
        twilioFrom: fields.twilioFrom.trim() || null,
        twilioTo: fields.twilioTo.trim() || null,
      };
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError((j as { error?: string }).error ?? `HTTP ${r.status}`);
        return;
      }
      setSavedNote("Saved.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [fields, refresh]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTestNote(null);
    try {
      const r = await fetch("/api/research/alert/test", { method: "POST" });
      const j = (await r.json()) as { ok: boolean; sent?: boolean; reason?: string };
      setTestNote(j.reason ?? (j.sent ? "sent" : "not sent"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const allSet =
    !!fields.twilioAccountSid.trim() &&
    !!fields.twilioAuthToken.trim() &&
    !!fields.twilioFrom.trim() &&
    !!fields.twilioTo.trim();

  const inputCls =
    "w-full bg-black/40 border border-neutral-700 rounded-sm px-2 py-1.5 text-[12px] text-neutral-200 font-mono focus:border-neutral-500 outline-none";

  return (
    <div>
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-[15px] font-medium text-neutral-100 flex items-center gap-2">
          <MessageSquare size={15} strokeWidth={1.8} className="text-neutral-400" />
          Twilio SMS fallback
        </h2>
        <span
          className="text-[10px] uppercase tracking-[0.18em] px-2 py-0.5 rounded-sm border"
          style={{
            borderColor: allSet ? "rgba(16,185,129,0.5)" : "rgba(120,120,120,0.4)",
            color: allSet ? "#10b981" : "#a3a3a3",
          }}
        >
          {allSet ? "Configured" : "Not configured"}
        </span>
      </div>
      <p className="text-[12px] text-neutral-500 mb-6">
        Backup alert channel. When Pushover is unset or a send fails and all
        four fields below are present, ARGOS delivers the alert as an SMS via
        Twilio. All optional — leave blank to disable the fallback.
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-300 inline-flex items-center gap-2">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      <div className="space-y-3">
        <label className="block">
          <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-1">Account SID</div>
          <input
            className={inputCls}
            value={fields.twilioAccountSid}
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            onChange={(e) => setFields((f) => ({ ...f, twilioAccountSid: e.target.value }))}
          />
        </label>
        <label className="block">
          <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-1">Auth Token</div>
          <input
            type="password"
            className={inputCls}
            value={fields.twilioAuthToken}
            placeholder="••••••••••••••••••••••••••••••••"
            onChange={(e) => setFields((f) => ({ ...f, twilioAuthToken: e.target.value }))}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-1">From (Twilio number)</div>
            <input
              className={inputCls}
              value={fields.twilioFrom}
              placeholder="+15551234567"
              onChange={(e) => setFields((f) => ({ ...f, twilioFrom: e.target.value }))}
            />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500 mb-1">To (your phone)</div>
            <input
              className={inputCls}
              value={fields.twilioTo}
              placeholder="+15559876543"
              onChange={(e) => setFields((f) => ({ ...f, twilioTo: e.target.value }))}
            />
          </label>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="text-[11px] uppercase tracking-[0.18em] px-3 py-1.5 rounded-sm border border-neutral-700 text-neutral-300 hover:border-neutral-500 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Save size={11} strokeWidth={2} /> Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void sendTest()}
            title="Sends a test alert through Pushover→Twilio"
            className="text-[11px] uppercase tracking-[0.18em] px-3 py-1.5 rounded-sm border border-neutral-700 text-neutral-300 hover:border-neutral-500 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Send size={11} strokeWidth={2} /> Send test alert
          </button>
          {savedNote && <span className="text-[11px] text-emerald-400">{savedNote}</span>}
        </div>

        {testNote && (
          <div className="rounded-md border border-neutral-800 bg-black/20 px-4 py-2 text-[11px] text-neutral-400">
            Test alert: <span className="font-mono text-neutral-300">{testNote}</span>
          </div>
        )}
      </div>
    </div>
  );
}
