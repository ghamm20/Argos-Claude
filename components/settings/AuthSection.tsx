// components/settings/AuthSection.tsx
//
// Operator Auth (2026-05-28) — Settings UI for the PIN gate.
//
// Three operator-facing affordances:
//   1. Require-PIN toggle (writes settings.requirePin)
//   2. Set PIN form — entry + confirm; hashes client-side; POSTs hash
//   3. Clear PIN button — sets operatorPinHash=null + requirePin=false
//
// The raw PIN NEVER leaves the browser. We compute the SHA-256 hex
// digest via window.crypto.subtle (hashPinClient) and only POST the
// hash to /api/settings.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Check, AlertTriangle, Loader2 } from "lucide-react";
import { hashPinClient, clearSessionToken } from "@/lib/auth-client";

interface SettingsSnapshot {
  requirePin: boolean;
  operatorPinHash: string | null;
}

export function AuthSection() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as SettingsSnapshot;
      setSnapshot({
        requirePin: !!j.requirePin,
        operatorPinHash: j.operatorPinHash ?? null,
      });
    } catch {
      /* ignore — UI shows nothing until fetch succeeds */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (text: string, ms = 2000) => {
    setMsg(text);
    window.setTimeout(() => setMsg(null), ms);
  };

  const toggleRequirePin = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        // Refuse to enable requirePin without a hash on file — would
        // lock the operator out immediately on next reload.
        if (next && !snapshot?.operatorPinHash) {
          flash("Set a PIN first before enabling the gate.", 3000);
          return;
        }
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requirePin: next }),
        });
        if (r.ok) {
          await refresh();
          flash(next ? "PIN gate enabled." : "PIN gate disabled.");
          if (!next) {
            // If they're disabling the gate, also clear the local
            // session token so the next reload doesn't carry stale
            // operator state into a now-guest world.
            clearSessionToken();
          }
        } else {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          flash(`failed: ${j.error ?? r.status}`, 3500);
        }
      } finally {
        setBusy(false);
      }
    },
    [refresh, snapshot?.operatorPinHash]
  );

  const setNewPin = useCallback(async () => {
    if (pin.length < 4 || pin.length > 8) {
      flash("PIN must be 4-8 characters.", 2500);
      return;
    }
    if (pin !== confirm) {
      flash("PIN and confirm do not match.", 2500);
      return;
    }
    setBusy(true);
    try {
      const pinHash = await hashPinClient(pin);
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorPinHash: pinHash }),
      });
      if (r.ok) {
        setPin("");
        setConfirm("");
        await refresh();
        flash("PIN set. Enable the gate to require it on reload.");
      } else {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        flash(`failed: ${j.error ?? r.status}`, 3500);
      }
    } finally {
      setBusy(false);
    }
  }, [pin, confirm, refresh]);

  const clearPin = useCallback(async () => {
    if (
      !window.confirm(
        "Clear the operator PIN and disable the gate? You'll boot directly into operator mode until a new PIN is set."
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorPinHash: null, requirePin: false }),
      });
      if (r.ok) {
        clearSessionToken();
        await refresh();
        flash("PIN cleared. Auth disabled.");
      } else {
        flash("clear failed", 2500);
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!snapshot) {
    return (
      <div className="text-[12px] text-neutral-500 flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading auth state…
      </div>
    );
  }

  const hasPin = !!snapshot.operatorPinHash;

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Lock size={14} className="text-neutral-500" />
          <h2 className="text-[14px] font-medium text-neutral-100">
            Operator Authentication
          </h2>
        </div>
        <p className="text-[11px] text-neutral-500">
          Two-mode operator gate. Guest mode hides operator profile, project
          context, and memory; personas respond in a generic, non-character
          register. Operator mode unlocks the full system.
        </p>
      </div>

      {/* Current state */}
      <div className="text-[12px] flex items-center gap-3 px-3 py-2 rounded border border-neutral-800 bg-neutral-900/40">
        <span className="text-neutral-500">Current state:</span>
        {hasPin ? (
          <span className="inline-flex items-center gap-1 text-emerald-400">
            <Check size={12} /> PIN set
          </span>
        ) : (
          <span className="text-neutral-400">No PIN configured</span>
        )}
        <span className="text-neutral-700">·</span>
        <span className={snapshot.requirePin ? "text-emerald-400" : "text-amber-400"}>
          {snapshot.requirePin ? "Gate enabled" : "Gate disabled (auto-operator)"}
        </span>
      </div>

      {/* Toggle */}
      <label className="flex items-start gap-3 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={snapshot.requirePin}
          onChange={(e) => void toggleRequirePin(e.target.checked)}
          disabled={busy || (!hasPin && !snapshot.requirePin)}
          className="mt-0.5"
        />
        <span>
          <span className="text-neutral-200">Require PIN to access Operator mode</span>
          <span className="block text-neutral-500 text-[11px] mt-0.5">
            When enabled, ARGOS boots into guest mode and requires the PIN on
            cold start. Disabled = current behavior (always operator).
          </span>
        </span>
      </label>

      {/* Set PIN */}
      <div className="border-t border-neutral-800/60 pt-5">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-neutral-400 mb-3">
          {hasPin ? "Change PIN" : "Set PIN"}
        </h3>
        <div className="space-y-2">
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={8}
            placeholder="New PIN (4-8 chars)"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="w-64 bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-[13px] font-mono tracking-[0.3em] text-neutral-100"
          />
          <input
            type="password"
            autoComplete="new-password"
            maxLength={8}
            placeholder="Confirm PIN"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-64 block bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-[13px] font-mono tracking-[0.3em] text-neutral-100"
          />
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void setNewPin()}
              disabled={busy || pin.length < 4 || pin !== confirm}
              className="px-3 py-1.5 rounded text-[12px] bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
            >
              {busy ? "Saving…" : hasPin ? "Update PIN" : "Set PIN"}
            </button>
            {hasPin && (
              <button
                type="button"
                onClick={() => void clearPin()}
                disabled={busy}
                className="px-3 py-1.5 rounded text-[12px] text-red-400 border border-red-700/60 hover:bg-red-900/20 disabled:opacity-50"
              >
                Clear PIN
              </button>
            )}
            {msg && (
              <span className="text-[11px] text-neutral-400">{msg}</span>
            )}
          </div>
        </div>
      </div>

      {/* Recovery */}
      <div className="border-t border-neutral-800/60 pt-5 text-[11px] text-amber-400/80 flex items-start gap-2">
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <div>
          <strong>Lost PIN recovery:</strong> if you forget your PIN, open{" "}
          <span className="font-mono text-amber-200">config/settings.json</span>{" "}
          on the USB and set{" "}
          <span className="font-mono text-amber-200">operatorPinHash</span> to{" "}
          <span className="font-mono text-amber-200">null</span> and{" "}
          <span className="font-mono text-amber-200">requirePin</span> to{" "}
          <span className="font-mono text-amber-200">false</span>. Restart ARGOS.
          You&apos;ll boot directly into operator mode and can set a fresh PIN.
        </div>
      </div>
    </div>
  );
}
