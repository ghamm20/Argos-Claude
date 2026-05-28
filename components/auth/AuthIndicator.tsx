// components/auth/AuthIndicator.tsx
//
// Operator Auth (2026-05-28) — HUD row showing current auth state.
//
//   🔓 GUEST     (amber)  — clicking triggers the PIN gate
//   🔑 OPERATOR  (teal)   — clicking offers Lock Session
//   (disabled)            — requirePin=false; renders a neutral row
//
// Polls /api/settings once on mount to learn whether the gate is even
// enabled. Reads the sessionStorage token directly to decide guest vs
// operator. Re-polls when window regains focus, so toggling auth in
// Settings reflects without a full reload.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Unlock, KeyRound, ShieldOff } from "lucide-react";
import {
  getSessionToken,
  clearSessionToken,
} from "@/lib/auth-client";

type AuthState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "guest" }
  | { kind: "operator" };

interface SettingsLite {
  requirePin?: boolean;
}

export function AuthIndicator() {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) {
        setState({ kind: "disabled" });
        return;
      }
      const j = (await r.json()) as SettingsLite;
      if (j.requirePin !== true) {
        setState({ kind: "disabled" });
        return;
      }
      const tok = getSessionToken();
      setState({ kind: tok ? "operator" : "guest" });
    } catch {
      setState({ kind: "disabled" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const triggerGate = useCallback(() => {
    // Easiest way to invoke the PinGate overlay is to clear the token
    // and reload — the overlay mounts on every page and re-runs its
    // settings probe + token check on every reload.
    clearSessionToken();
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  const lockSession = useCallback(() => {
    if (
      !window.confirm(
        "Lock the operator session? You'll return to guest mode and need the PIN to re-enter."
      )
    ) {
      return;
    }
    clearSessionToken();
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  // Render shape mirrors the HUD's Row component so the indicator
  // slots in cleanly. We don't import the Row helper because it's
  // local to HUD.tsx; the inline copy here keeps the styling stable
  // even if HUD evolves.
  if (state.kind === "loading") {
    return (
      <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0">
        <span className="uppercase tracking-[0.16em] text-neutral-500">Auth</span>
        <span className="font-mono text-[11px] text-neutral-600">…</span>
      </div>
    );
  }

  if (state.kind === "disabled") {
    return (
      <div
        className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0"
        title="Auth gate is disabled (settings.requirePin=false). Every request is treated as operator."
      >
        <span className="uppercase tracking-[0.16em] text-neutral-500">Auth</span>
        <span className="font-mono text-[11px] text-neutral-500 inline-flex items-center gap-1">
          <ShieldOff size={11} /> off
        </span>
      </div>
    );
  }

  if (state.kind === "guest") {
    return (
      <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0">
        <span className="uppercase tracking-[0.16em] text-neutral-500">Auth</span>
        <button
          type="button"
          onClick={triggerGate}
          title="Click to enter operator PIN"
          className="font-mono text-[11px] inline-flex items-center gap-1 hover:underline"
          style={{ color: "#f59e0b" }}
        >
          <Unlock size={11} /> 🔓 GUEST
        </button>
      </div>
    );
  }

  // operator
  return (
    <div className="flex items-center justify-between text-[11px] py-1.5 border-b border-neutral-800/50 last:border-b-0">
      <span className="uppercase tracking-[0.16em] text-neutral-500">Auth</span>
      <button
        type="button"
        onClick={lockSession}
        title="Click to lock — clears token and returns to guest mode"
        className="font-mono text-[11px] inline-flex items-center gap-1 hover:underline"
        style={{ color: "#00ff9d" }}
      >
        <KeyRound size={11} /> 🔑 OPERATOR
      </button>
    </div>
  );
}
